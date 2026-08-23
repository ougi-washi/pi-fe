# PI For Engineers

`pi-fe` is a minimal continuous implementation plugin for Pi. It watches a project and asks Pi to keep C and C++ implementations synchronized with the declarations written by the user.

The watcher is language-neutral. C and C++ are the first implementation policy; adding another language later does not require replacing the watcher.

## Install

```sh
pi install /absolute/path/to/pi-fe
```

The package is a standard Pi extension loaded through the `pi.extensions` entry in `package.json`.

Requirements:

- Pi 0.84.2-compatible runtime
- Node.js 22.19 or newer

There is no configuration file, compile database, Clang integration, parser, generated symbol list, or custom LLM tool.

## Use

Run this command inside a trusted Pi project session:

```text
/pi-fe
```

The first call enables the watcher. If tracked working-tree changes already exist, Pi receives their exact paths and compact Git diff as the first hidden implementation pass; a clean tree waits for the next filesystem change. The next call disables the watcher. The footer and notification use the terse states `pi-fe:on` and `pi-fe:off`.

While enabled, file changes are debounced and coalesced. Only one automatic implementation pass is outstanding. Changes received while Pi is working are queued for the next pass. Pi-authored edits cause a convergence pass; when that pass makes no further edit, the plugin waits for the next filesystem change.

Every ordinary project file can trigger analysis. Only `.git`, `node_modules`, editor swap files, and temporary files are ignored. The watcher does not interpret languages or declarations.

## Ownership

User-authored structs, classes, unions, enums, fields, bases, templates, declarations, and authoritative signatures are immutable inputs. Headers and other declarations are the authority.

During an automatic C/C++ pass, Pi may only:

- fill or update a matching function, method, constructor, or destructor body in an existing implementation file;
- add an unambiguous out-of-line definition to an existing implementation file;
- mirror an authoritative declaration exactly in the corresponding implementation-side signature;
- add a strictly necessary include to an implementation file.

Pi does not create source files, headers, tests, documentation, configuration, APIs, helper types, scaffolding, abstractions, fallbacks, logging, retries, compatibility behavior, or unrelated cleanup. It does not run a plugin-managed compiler, formatter, test, benchmark, or verification pipeline.

Automatic passes are declaration-scoped, not project audits. They do not inspect TODO files, select unrelated work, read Git history, perform repository-wide scans, or run shell commands. The `bash` tool is blocked only for automatic watcher turns; normal interactive Pi turns remain unrestricted.

Implementations must be the simplest, most direct, and most efficient form supported by the existing contract. Workarounds are forbidden. If a serious concern makes implementation impossible, Pi may add one concise `// @TODO:` or `// @NOTE:` beside the relevant existing implementation location. If no existing implementation file or unambiguous location exists, it leaves the declaration untouched.

## Enforcement boundary

The ownership contract is injected into Pi's transient model context only while a hidden watcher message is being processed; it is not stored in later conversation context. Normal user turns keep Pi's ordinary system prompt, tools, rendering, and behavior.

Because `pi-fe` deliberately uses no compiler frontend or language parser, it does not claim to prove structurally that every model edit preserves declarations. The plugin stays small; preservation is enforced by the automatic agent instruction.

## Development

```sh
npm install
npm run typecheck
npm test
```
