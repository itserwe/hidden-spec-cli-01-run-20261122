[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/itserwe/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/itserwe/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend

[![Node 22](https://img.shields.io/badge/Node-22-green)](#)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![make.fun](https://img.shields.io/badge/make.fun-hidden--spec--cli--01-blue)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files. Models write
edits in four formats, and `mend` reads them all: a unified diff (often with wrong
line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool
calls as JSON. Every file is changed or nothing is.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- The working directory is the root of the tree. Every path in a patch is relative to it.
- `PATCH` is the path of the patch file, relative to the working directory. When it is
  absent or is `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`, `v4a`
  or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as without it,
  and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- Options and `PATCH` may come in any order. `--` ends the options.

## Matching

Unified hunks, SEARCH/REPLACE blocks and V4A chunks name old lines that are replaced
by new lines. The old lines are found at the first of three tiers at which they occur
at least once: tier 0 (every line equal), tier 1 (trailing spaces and tabs ignored),
tier 2 (leading and trailing spaces and tabs ignored). At tier 2 the new lines are
re-indented from the patch's indentation to the file's. A context line is always
written as the file's own matched line, never the patch's.

Each format picks its occurrence its own way: a unified hunk takes the occurrence
nearest to the line number the hunk names; a SEARCH/REPLACE block needs exactly one
occurrence or it fails ambiguous; a V4A chunk takes the first occurrence at or after
its cursor, after its anchor.

## Exit codes

- `0`: the tree is written. One line per changed path (`A`, `D`, `M`, or `R old -> new`
  for a move), then `ok: <n> files`.
- `1`: nothing is written. One `error: <code> <path>` line per failed edit, then
  `failed: <k> of <n> edits`.
- `2`: nothing is written. Exactly one line: `error: usage`, `error: no-patch`,
  `error: format`, or `error: parse <N>`.

## Files

- `main.ts` — the CLI. Node 22, standard library only.
- `runner.ts` — the kit's trial runner (kept as the kit has it).
- `check.ts` — runs `main.ts` on the kit's practice set: `node check.ts <practice.json>`.
- `SPEC.md` — the whole contract.

## License

MIT. See [LICENSE](LICENSE).
