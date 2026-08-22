# PI For Engineers

**PI For Engineers** (`pi-fe`) is a fail-closed Pi 0.84.2 implementation plugin. It watches all eligible project inputs during the active Pi session, turns external changes into hidden analysis runs, and implements only existing function-level areas in `.c` and `.cpp` files through a Clang-backed mutation pipeline.

It never changes structures, classes, unions, enums, fields, bases, templates, declarations, signatures, headers, or API/ABI surfaces. It never creates source files or invents tests, scaffolding, abstractions, retries, logging, fallback behavior, placeholders, or workaround code. When an exact high-quality implementation cannot be proven from the existing contract, it leaves only a technical `//@TODO:` or `//@NOTE:`.

## Install

```sh
pi install /absolute/path/to/pi-fe
```

The package manifest loads `src/index.ts`. Runtime dependencies are production dependencies; Pi core packages and `typebox` are peers.

Requirements:

- Pi 0.84.2-compatible runtime
- Node.js 22.19 or newer
- Git for Git-aware watch scope
- Clang and exactly one `compile_commands.json`
- Original project compiler flags that work from the current working tree

The extension creates no configuration file. It starts and stops its watcher with the Pi session.

## Strict contract

Watching is broad; mutation is deliberately narrow. Headers, tests, call sites, build definitions, and contract documentation may trigger and inform analysis, but only contract-backed implementation bodies or exact declared out-of-line definitions in existing `.c`/`.cpp` files can be changed. Tests are evidence and configured validation—not a place to hide a workaround or generate meaningless coverage.

Active LLM tools are limited to:

```text
read grep find ls cxx_contract cxx_check cxx_apply cxx_todo cxx_finalize
```

A separate `tool_call` gate blocks every other tool, including `bash`, `write`, and `edit`, and verifies that allowed names still belong to Pi built-ins or this package. `cxx_apply` accepts only existing, canonical, non-symlink `.c` and `.cpp` files under the repository root. It rejects file creation, headers, stale hashes/generations, overlapping or non-unique replacements, declaration/ABI/definition/preprocessor/template changes, unmatched symbols, new unproven performance operations, and candidates that add compiler diagnostics or configured failures. Every touched symbol needs both exact header-declaration evidence and symbol-tied behavioral evidence (`header_contract`, `test`, `call_site`, `sibling`, or `documentation` with a concrete constraint); a bare declaration is ambiguous and must use `cxx_todo`.

Ambiguity is recorded only through grammar-checked comments such as:

```cpp
//@TODO: reason=ambiguous_contract symbol=Widget::update header=include/widget.hpp:41 required=ownership,error_policy
//@NOTE: evidence=test path=test/widget_test.cpp:92 constraint=preserve_allocation_count
```

Assistant prose and thinking are removed from rendering and persistence. Every strict run must end with `cxx_finalize`, whose tool result is terminating structured JSON.

## Tools

- **`cxx_contract`** — loads the unique compile command, runs Clang JSON AST extraction, and returns declarations, definitions, body ranges, references, diagnostics, compile-command evidence, and the header Merkle root.
- **`cxx_check`** — runs only named compile/configured-test checks using executable-plus-argv commands.
- **`cxx_apply`** — builds candidates in memory, verifies evidence and hashes, parses baseline/candidate ASTs, performs structural/export/performance checks in a copied temporary workspace, runs differential configured checks, rechecks races, and commits through Pi's file mutation queue.
- **`cxx_todo`** — inserts only validated `//@TODO:` or `//@NOTE:` lines in existing source files, with the same generation/hash/commit checks.
- **`cxx_finalize`** — validates the run result and terminates without a prose follow-up.

Tool output is truncated with Pi's standard 2,000-line/50-KB limits.

## Watch behavior

In Git repositories, tracked files and untracked files not excluded by Git are eligible. `.git`, dependency trees, conventional output/generated directories, caches, and editor temporary files are ignored. In non-Git directories, configured include/exclude globs apply.

Events are canonicalized, hashed, debounced, coalesced, and assigned generations. Atomic saves at one pathname collapse to one change; matching remove/add hashes can be reported as renames. A committed source hash is suppressed once, while any unexpected hash remains external. Only one automatic run is outstanding; newer batches replace the pending generation and are queued as a Pi `followUp`.

## Trusted configuration

For a trusted project, optional configuration is read from `.pi/pi-fe.json` (preferred) or `.pi-fe.json`. Command values are argv arrays and are never interpreted as shell source.

```json
{
  "enabled": true,
  "compileCommands": "build/compile_commands.json",
  "watch": {
    "debounceMs": 250,
    "exclude": ["build/**", "vendor/**", "generated/**"]
  },
  "verification": {
    "tests": [
      {
        "id": "widget-unit",
        "paths": ["src/widget.cpp"],
        "argv": ["ctest", "--test-dir", "build", "-R", "widget"]
      }
    ],
    "benchmarks": [
      {
        "id": "widget-benchmark",
        "paths": ["src/widget.cpp"],
        "symbols": ["Widget::update"],
        "argv": ["./build/widget-benchmark"],
        "warmup": 1,
        "samples": 5
      }
    ]
  },
  "performance": {
    "hotSymbols": ["Widget::update"],
    "maxRegressionPercent": 2
  }
}
```

No test, linter, formatter, sanitizer, benchmark, retry, fallback, or workaround command is invented. Existing `.clang-tidy` and `.clang-format` files opt their corresponding changed-path checks in. Raw shell executables are rejected even when represented as argv. Baseline and candidate commands run in separate symlink-free temporary snapshots, never in the live working tree.

## Atomicity and trust boundary

Candidates never replace working-tree source before validation. Each final file replacement uses a same-directory temporary file, `fsync`, and rename; multi-file failures are rolled back when the committed candidate hash is still present. Generation, header-root, evidence, and source hashes are rechecked immediately before commit and before each rename.

Portable filesystems do not provide a multi-path atomic commit or a pathname compare-and-swap. Consequently, no Node extension can make several renames simultaneously visible or prevent an uncooperative process from writing in the final hash-check/rename interval. `pi-fe` detects races at every available boundary, serializes cooperating Pi mutations, and reports rollback conflicts rather than overwriting an unexpected post-commit hash. Projects requiring stronger guarantees must run on a transactional/CAS filesystem or restrict each request to one file.

Trusted compile databases and configured commands can execute project toolchains and are not a sandbox. Temporary verification copies do not hard-link working-tree files.

## Development

```sh
npm install
npm run typecheck
npm test
```

Tests cover confinement, traversal/symlink denial, exact edits, TODO grammar, header hashing, Git-aware debounce and self-write suppression, Clang extraction and compile-database ambiguity, stale/racing transactions, structural rejection, and atomic-save watcher behavior. Fixtures include C, C++, macro, and template cases.
