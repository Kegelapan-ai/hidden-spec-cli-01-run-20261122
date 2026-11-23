# mend — one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Kegelapan-ai/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Kegelapan-ai/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

Built for the make.fun bounty: https://make.fun/bounty/hidden-spec-cli-01-run-20261122

An entry for the [make.fun bounty "Build mend, one patch tool for every AI edit format"](https://make.fun/bounty/hidden-spec-cli-01-run-20261122): a command-line tool that applies AI-written edits in four formats to a tree of files, to the written specification in `SPEC.md` — and changes every file or none.

## What it does

Agent harnesses apply edits that models write, and models write them in four formats. `mend` reads all four to one specification:

1. **Unified diffs** — often with wrong line numbers. Hunks are matched by content, taking the occurrence nearest the hunk's stated line, adjusted for earlier hunks.
2. **SEARCH/REPLACE blocks** — a path line, `<<<<<<< SEARCH`, old lines, `=======`, new lines, `>>>>>>> REPLACE`.
3. **V4A patches** — `*** Begin Patch` … `*** End Patch`, with Add / Delete / Update File sections, `@@` anchors, `*** Move to:` and `*** End of File`.
4. **JSON tool calls** — one array of edit objects, or one edit object per line (`create`, `str_replace`, `insert`).

It finds the lines an edit names even when the model drifted their whitespace or indentation (three matching tiers: exact, trailing whitespace ignored, both ends ignored — with re-indentation of new lines at the loosest tier), and it is atomic: a failed edit changes nothing, edits after it still run and are all reported, and when any edit fails no file is written at all.

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- The working directory is the root of the tree; every path in a patch is relative to it.
- `PATCH` is the patch file, or `-` / absent to read the patch from standard input.
- `--format=NAME` reads one format: `unified`, `search-replace`, `v4a`, `json`; `auto` (the default) detects it.
- `--check` does everything but write: same output and exit code, no file created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit codes: `0` with one line per changed path (`A`/`D`/`M`, `R old -> new` for moves) and `ok: <n> files`; `1` with one `error: <code> <path>` line per failed edit and `failed: <k> of <n> edits`; `2` with a single line for usage, unreadable patch, undetected format or parse errors.

Node 22 and its standard library only — nothing is installed. The program is deterministic: the same check always gives the same exit code, stdout and files.

## Files

- `main.ts` — the CLI (built on the kit starter's command line, detection, JSON edits and all-or-nothing write; the three other formats and three-tier matching are implemented here).
- `runner.ts` — the kit's trial runner, as shipped. `main.ts` hands a trial over to it when `MAKEFUN_ENV_URL` is set.
- `check.ts` — runs `main.ts` on the kit's practice set: `node check.ts <practice.json>`.
- `SPEC.md` — the specification this tool implements, as shipped in the kit.
- `LICENSE` — MIT.

## Verification

- Practice set: **100 of 100 passed, practice score 1000**, run under Node v22.19.0 (the grader's runtime) and Node v24.
- Two full practice runs produce byte-identical output (determinism check).
- 136 additional edge-case checks derived sentence-by-sentence from `SPEC.md` (invocation, tiers and re-indentation, unified hunks and `\ No newline at end of file`, SEARCH/REPLACE paths, V4A anchors/cursor/end-of-file, JSON faults, move chains, CRLF files, byte-order sorting) all pass under Node 22 — see `../work/edge-tests.mjs` in the build workspace (not part of this repo).
