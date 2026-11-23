// mend: one patch tool for every AI edit format, as SPEC.md (version 1) specifies.
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// It reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks, V4A
// patches, JSON tool-call edits), finds the lines each edit names at the first of
// three matching tiers (exact, trailing whitespace ignored, both ends ignored),
// and changes every file or none (atomic), deterministically.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then
// this file hands over to runner.ts (the last lines below): keep that hand-over and
// runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

interface Move {
  old: string;
  nu: string;
}

type Edit = (tree: Tree) => void;

/* ------------------------------------------------------------------ */
/* Section 3: a file as lines, its line break, and its final break.    */
/* ------------------------------------------------------------------ */

interface FileDoc {
  br: string;
  lines: string[];
  fin: boolean;
}

function splitFile(text: string): FileDoc {
  if (text === '') return { br: '\n', lines: [], fin: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let fin = false;
  if (text.endsWith(br)) {
    parts.pop();
    fin = true;
  }
  return { br, lines: parts, fin };
}

function joinFile(d: FileDoc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.fin ? d.br : '');
}

/* ------------------------------------------------------------------ */
/* Section 5: matching lines at three tiers, and re-indenting.         */
/* ------------------------------------------------------------------ */

function tierNorm(l: string, tier: number): string {
  if (tier === 0) return l;
  if (tier === 1) return l.replace(/[ \t]+$/, '');
  return l.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadWs(l: string): string {
  const m = /^[ \t]*/.exec(l);
  return m === null ? '' : m[0];
}

/** Positions i >= from where O matches file lines at this tier (overlaps count). */
function occurrencesAt(file: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > file.length) return out;
  const on = o.map((l) => tierNorm(l, tier));
  for (let i = from; i + o.length <= file.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (tierNorm(file[i + j]!, tier) !== on[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) with an occurrence at/after `from`. */
function findTier(file: string[], o: string[], strict: boolean, from: number): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrencesAt(file, o, t, from);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

/** One line of N: `text` is the patch's line; `ctx` is its index in O when it is a
 *  context line (written as the file's own matched line), else null. */
interface NEntry {
  text: string;
  ctx: number | null;
}

function reindentOne(text: string, p: string, f: string): string {
  if (text === '' || /^[ \t]+$/.test(text)) return text;
  return text.startsWith(p) ? f + text.slice(p.length) : text;
}

/** The lines that replace the matched O at `pos`: context lines as the file's own,
 *  other lines re-indented at tier 2 (P: O's first line's lead, F: the file's). */
function buildReplacement(n: NEntry[], o: string[], file: string[], pos: number, tier: number): string[] {
  let p = '';
  let f = '';
  if (tier === 2 && o.length > 0) {
    p = leadWs(o[0]!);
    f = leadWs(file[pos]!);
  }
  return n.map((e) => {
    if (e.ctx !== null) return file[pos + e.ctx]!;
    if (tier === 2 && o.length > 0) return reindentOne(e.text, p, f);
    return e.text;
  });
}

/* ------------------------------------------------------------------ */
/* Section 4: detecting the format.                                    */
/* ------------------------------------------------------------------ */

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ------------------------------------------------------------------ */
/* Section 9: JSON edits (one array, or one edit object per line).     */
/* ------------------------------------------------------------------ */

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const doc = splitFile(before);
      if (line < 0 || line > doc.lines.length) throw new Fail('no-match', p);
      doc.lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(doc));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Section 6: unified diffs.                                           */
/* ------------------------------------------------------------------ */

interface UniBodyLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
  raw: string;
}

interface UniHunk {
  a: number;
  body: UniBodyLine[];
}

interface UniSection {
  gitOld: string | null;
  gitNew: string | null;
  oldPath: string | null | undefined;
  newPath: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: UniHunk[];
}

/** The path of a `--- ` / `+++ ` header line: after the four characters, up to the
 *  first tab, surrounding spaces removed, a leading a/ or b/ removed; null is /dev/null. */
function headerPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseUnified(lines: string[], strict: boolean, moves: Move[]): Edit[] {
  const sections: UniSection[] = [];
  let sec: UniSection | null = null;
  let hunk: UniHunk | null = null;

  const finishHunk = (): void => {
    if (hunk !== null && sec !== null) {
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.raw === '') hunk.body.pop();
      sec.hunks.push(hunk);
      hunk = null;
    }
  };
  const finishSection = (): void => {
    finishHunk();
    if (sec !== null) sections.push(sec);
    sec = null;
  };
  const startSection = (gitOld: string | null, gitNew: string | null): void => {
    finishSection();
    sec = {
      gitOld,
      gitNew,
      oldPath: undefined,
      newPath: undefined,
      renameFrom: undefined,
      renameTo: undefined,
      newFile: false,
      deletedFile: false,
      hunks: [],
    };
  };
  const setPair = (s: UniSection, minusLine: string, plusLine: string): void => {
    s.oldPath = headerPath(minusLine);
    s.newPath = headerPath(plusLine);
  };
  const parseGitLine = (line: string, idx: number): [string, string] => {
    const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (m === null) throw new Exit2(`error: parse ${idx + 1}`);
    return [m[1]!, m[2]!];
  };
  const parseHunkHeader = (line: string, idx: number): number => {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: |$)/.exec(line);
    if (m === null) throw new Exit2(`error: parse ${idx + 1}`);
    return parseInt(m[1]!, 10);
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (hunk !== null) {
      // Collecting a hunk body.
      if (line.startsWith('diff --git ')) {
        finishHunk();
        finishSection();
        const [o, n] = parseGitLine(line, i);
        startSection(o, n);
        i++;
        continue;
      }
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        finishHunk();
        finishSection();
        startSection(null, null);
        setPair(sec!, line, lines[i + 1]!);
        i += 2;
        continue;
      }
      if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\') {
        hunk.body.push({ kind: line === '' ? ' ' : (line[0] as ' ' | '-' | '+' | '\\'), text: line === '' ? '' : line.slice(1), raw: line });
        i++;
        continue;
      }
      finishHunk();
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const [o, n] = parseGitLine(line, i);
      startSection(o, n);
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (sec !== null && sec.hunks.length === 0) {
        // Part of this section's header, not a new section.
        setPair(sec, line, lines[i + 1]!);
        i += 2;
        continue;
      }
      startSection(null, null);
      setPair(sec!, line, lines[i + 1]!);
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
      hunk = { a: parseHunkHeader(line, i), body: [] };
      i++;
      continue;
    }
    if (sec !== null && sec.hunks.length === 0) {
      // Header lines, before the first hunk.
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ')) {
        sec.newPath = headerPath(line);
        i++;
        continue;
      }
      if (line.startsWith('rename from ')) {
        sec.renameFrom = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        sec.renameTo = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        sec.newFile = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        sec.deletedFile = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    // No section yet, or after a hunk: prose, ignored.
    i++;
  }
  finishSection();
  return sections.map((s) => unifiedEdit(s, strict, moves));
}

/** A `\` line follows the hunk's last context or `+` line: no line break at the end. */
function hunkNoEol(h: UniHunk): boolean {
  let last = -1;
  for (let bi = 0; bi < h.body.length; bi++) {
    if (h.body[bi]!.kind === ' ' || h.body[bi]!.kind === '+') last = bi;
  }
  return last >= 0 && h.body[last + 1] !== undefined && h.body[last + 1]!.kind === '\\';
}

/** The hunks of one section, applied in order to the file's lines. */
function applyUnifiedHunks(doc: FileDoc, hunks: UniHunk[], strict: boolean, path: string): FileDoc {
  let lines = doc.lines;
  let fin = doc.fin;
  let d = 0;
  for (const h of hunks) {
    const o: string[] = [];
    const n: NEntry[] = [];
    let oIdx = 0;
    for (const b of h.body) {
      if (b.kind === ' ') {
        o.push(b.text);
        n.push({ text: b.text, ctx: oIdx });
        oIdx++;
      } else if (b.kind === '-') {
        o.push(b.text);
        oIdx++;
      } else if (b.kind === '+') {
        n.push({ text: b.text, ctx: null });
      }
    }
    const noEol = hunkNoEol(h);
    if (o.length > 0) {
      const found = findTier(lines, o, strict, 0);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let pos = found.positions[0]!;
      let best = Math.abs(pos - target);
      for (const p of found.positions) {
        const dd = Math.abs(p - target);
        if (dd < best) {
          best = dd;
          pos = p;
        }
      }
      const rep = buildReplacement(n, o, lines, pos, found.tier);
      if (pos + o.length === lines.length) fin = !noEol;
      lines = [...lines.slice(0, pos), ...rep, ...lines.slice(pos + o.length)];
      d += n.length - o.length;
    } else {
      const idx = Math.min(h.a + d, lines.length);
      if (idx === lines.length) fin = !noEol;
      lines = [...lines.slice(0, idx), ...n.map((e) => e.text), ...lines.slice(idx)];
      d += n.length;
    }
  }
  return { br: doc.br, lines, fin };
}

/** The text of a created file: the `+` lines of all hunks, in order. */
function creationText(hunks: UniHunk[]): string {
  const plus: string[] = [];
  for (const h of hunks) for (const b of h.body) if (b.kind === '+') plus.push(b.text);
  if (plus.length === 0) return '';
  let noEol = false;
  outer: for (let hi = hunks.length - 1; hi >= 0; hi--) {
    const h = hunks[hi]!;
    for (let bi = h.body.length - 1; bi >= 0; bi--) {
      if (h.body[bi]!.kind === '+') {
        noEol = h.body[bi + 1] !== undefined && h.body[bi + 1]!.kind === '\\';
        break outer;
      }
    }
  }
  return plus.join('\n') + (noEol ? '' : '\n');
}

function unifiedEdit(sec: UniSection, strict: boolean, moves: Move[]): Edit {
  const oldP0 = sec.oldPath !== undefined ? sec.oldPath : sec.renameFrom !== undefined ? sec.renameFrom : sec.gitOld;
  const newP0 = sec.newPath !== undefined ? sec.newPath : sec.renameTo !== undefined ? sec.renameTo : sec.gitNew;
  const oldP = oldP0 !== undefined ? oldP0 : newP0;
  const newP = newP0 !== undefined ? newP0 : oldP0;
  const isCreation = oldP === null || sec.newFile;
  const isDeletion = !isCreation && (newP === null || sec.deletedFile);
  return (tree) => {
    if (oldP === undefined && newP === undefined) return;
    if (isCreation) {
      const p = newP as string | null;
      if (p === null || p === undefined) return;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, creationText(sec.hunks));
      return;
    }
    if (isDeletion) {
      const p = oldP as string | null;
      if (p === null || p === undefined) return;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const oldPath = oldP as string;
    const newPath = newP as string;
    if (oldPath !== newPath) {
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      const cur = tree.get(oldPath);
      if (cur === null) throw new Fail('missing', oldPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const out = applyUnifiedHunks(splitFile(cur), sec.hunks, strict, oldPath);
      tree.now.set(oldPath, null);
      tree.now.set(newPath, joinFile(out));
      moves.push({ old: oldPath, nu: newPath });
      return;
    }
    if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
    const cur = tree.get(oldPath);
    if (cur === null) throw new Fail('missing', oldPath);
    const out = applyUnifiedHunks(splitFile(cur), sec.hunks, strict, oldPath);
    tree.now.set(oldPath, joinFile(out));
  };
}

/* ------------------------------------------------------------------ */
/* Section 7: SEARCH/REPLACE blocks.                                   */
/* ------------------------------------------------------------------ */

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const doc = splitFile(cur);
    const found = findTier(doc.lines, oldLines, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = found.positions[0]!;
    const rep = buildReplacement(
      newLines.map((t) => ({ text: t, ctx: null })),
      oldLines,
      doc.lines,
      pos,
      found.tier,
    );
    const lines = [...doc.lines.slice(0, pos), ...rep, ...doc.lines.slice(pos + oldLines.length)];
    tree.now.set(path, joinFile({ br: doc.br, lines, fin: doc.fin }));
  };
}

function parseSR(lines: string[], strict: boolean): Edit[] {
  const isSearch = (l: string): boolean => l.trimEnd() === '<<<<<<< SEARCH';
  const isEq = (l: string): boolean => l.trimEnd() === '=======';
  const isRep = (l: string): boolean => l.trimEnd() === '>>>>>>> REPLACE';
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1;
  let i = 0;
  for (;;) {
    let s = -1;
    for (let j = i; j < lines.length; j++) {
      if (isSearch(lines[j]!)) {
        s = j;
        break;
      }
    }
    if (s < 0) break;
    let e = -1;
    for (let j = s + 1; j < lines.length; j++) {
      if (isEq(lines[j]!)) {
        e = j;
        break;
      }
    }
    if (e < 0) throw new Exit2(`error: parse ${s + 1}`);
    let r = -1;
    for (let j = e + 1; j < lines.length; j++) {
      if (isRep(lines[j]!)) {
        r = j;
        break;
      }
    }
    if (r < 0) throw new Exit2(`error: parse ${s + 1}`);
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    prevPath = path;
    prevEnd = r;
    edits.push(srEdit(path, lines.slice(s + 1, e), lines.slice(e + 1, r), strict));
    i = r + 1;
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* Section 8: V4A patches.                                             */
/* ------------------------------------------------------------------ */

interface VBodyLine {
  kind: ' ' | '-' | '+';
  text: string;
  blank: boolean;
}

interface VChunk {
  anchor: string | null;
  body: VBodyLine[];
  eof: boolean;
}

type VSection =
  | { kind: 'add'; path: string; lines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo: string | null; chunks: VChunk[] };

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean, moves: Move[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const doc = splitFile(cur);
    let lines = doc.lines;
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const found = findTier(lines, [ch.anchor], strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.positions[0]! + 1;
      }
      const o: string[] = [];
      const n: NEntry[] = [];
      let oIdx = 0;
      for (const b of ch.body) {
        if (b.kind === ' ') {
          o.push(b.text);
          n.push({ text: b.text, ctx: oIdx });
          oIdx++;
        } else if (b.kind === '-') {
          o.push(b.text);
          oIdx++;
        } else {
          n.push({ text: b.text, ctx: null });
        }
      }
      if (o.length > 0) {
        let picked: { tier: number; pos: number } | null = null;
        for (const t of strict ? [0] : [0, 1, 2]) {
          const occ = occurrencesAt(lines, o, t, cursor).filter((p) => !ch.eof || p + o.length === lines.length);
          if (occ.length > 0) {
            picked = { tier: t, pos: occ[0]! };
            break;
          }
        }
        if (picked === null) throw new Fail('no-match', path);
        const rep = buildReplacement(n, o, lines, picked.pos, picked.tier);
        lines = [...lines.slice(0, picked.pos), ...rep, ...lines.slice(picked.pos + o.length)];
        cursor = picked.pos + rep.length;
      } else {
        const idx = ch.eof ? lines.length : cursor;
        const rep = n.map((e) => e.text);
        lines = [...lines.slice(0, idx), ...rep, ...lines.slice(idx)];
        cursor = idx + rep.length;
      }
    }
    const text = joinFile({ br: doc.br, lines, fin: doc.fin });
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, text);
      moves.push({ old: path, nu: moveTo });
    } else {
      tree.now.set(path, text);
    }
  };
}

function parseV4A(lines: string[], strict: boolean, moves: Move[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = lines.length - 1; j >= 0; j--) {
    if (!blank(lines[j]!)) {
      last = j;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      const secLines: { text: string; blank: boolean }[] = [];
      i++;
      while (i < last) {
        const l = lines[i]!;
        if (isSectionStart(l)) break;
        if (l.startsWith('+')) {
          secLines.push({ text: l.slice(1), blank: false });
          i++;
          continue;
        }
        if (blank(l)) {
          secLines.push({ text: '', blank: true });
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (secLines.length > 0 && secLines[secLines.length - 1]!.blank) secLines.pop();
      sections.push({ kind: 'add', path, lines: secLines.map((s) => s.text) });
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      i++;
      while (i < last) {
        const l = lines[i]!;
        if (isSectionStart(l)) break;
        if (blank(l)) {
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      sections.push({ kind: 'delete', path });
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const updateIdx = i;
      const path = line.slice('*** Update File: '.length).trim();
      i++;
      let moveTo: string | null = null;
      let moveSeen = false;
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let anyChunk = false;
      const closeChunk = (trimBlank: boolean): void => {
        if (cur !== null) {
          if (trimBlank) while (cur.body.length > 0 && cur.body[cur.body.length - 1]!.blank) cur.body.pop();
          chunks.push(cur);
          cur = null;
        }
      };
      while (i < last) {
        const l = lines[i]!;
        if (isSectionStart(l)) break;
        if (blank(l)) {
          if (cur !== null) cur.body.push({ kind: ' ', text: '', blank: true });
          i++;
          continue;
        }
        if (l.startsWith('*** Move to: ')) {
          if (cur !== null || anyChunk || moveSeen) throw new Exit2(`error: parse ${i + 1}`);
          moveTo = l.slice('*** Move to: '.length).trim();
          moveSeen = true;
          i++;
          continue;
        }
        if (l === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          closeChunk(false);
          i++;
          continue;
        }
        if (l.startsWith('@@')) {
          closeChunk(false);
          const anchorText = l.slice(2).trim();
          cur = { anchor: anchorText === '' ? null : anchorText, body: [], eof: false };
          anyChunk = true;
          i++;
          continue;
        }
        if (l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) {
            if (anyChunk) throw new Exit2(`error: parse ${i + 1}`);
            cur = { anchor: null, body: [], eof: false };
            anyChunk = true;
          }
          cur.body.push({ kind: l[0] as ' ' | '-' | '+', text: l.slice(1), blank: false });
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      closeChunk(true);
      if (chunks.length === 0 && !moveSeen) throw new Exit2(`error: parse ${updateIdx + 1}`);
      sections.push({ kind: 'update', path, moveTo, chunks });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return sections.map((s) => {
    if (s.kind === 'add') return v4aAddEdit(s.path, s.lines);
    if (s.kind === 'delete') return v4aDeleteEdit(s.path);
    return v4aUpdateEdit(s.path, s.moveTo, s.chunks, strict, moves);
  });
}

/* ------------------------------------------------------------------ */
/* Sections 1, 2 and 10: invocation, output, order and atomicity.      */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: Move[] = [];
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict, moves);
    else if (kind === 'search-replace') edits = parseSR(lines, strict);
    else edits = parseV4A(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // One line per path whose state changed, in byte order of the paths (UTF-8).
  // A move replaces its D and A lines with one R line, sorting by the new path.
  const rows: { key: string; line: string }[] = [];
  const covered = new Set<string>();
  const nextOf = new Map<string, string>();
  for (const m of moves) nextOf.set(m.old, m.nu);
  for (const m of moves) {
    let n = m.nu;
    const seen = new Set<string>([m.old]);
    while (nextOf.has(n) && !seen.has(n)) {
      seen.add(n);
      n = nextOf.get(n)!;
    }
    if (n === m.old) continue;
    const wasOld = tree.original(m.old);
    const nowOld = tree.now.has(m.old) ? tree.now.get(m.old)! : tree.original(m.old);
    const wasNew = tree.original(n);
    const nowNew = tree.now.has(n) ? tree.now.get(n)! : tree.original(n);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: n, line: `R ${m.old} -> ${n}` });
      covered.add(m.old);
      covered.add(n);
    }
  }
  for (const p of tree.now.keys()) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
