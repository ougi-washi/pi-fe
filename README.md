# pi-fe

Minimal continuous C/C++ implementation watcher for Pi.

## Install

```sh
pi install git:github.com/ougi-washi/pi-fe
```

## Use

```text
/pi-fe
```

- Toggles the watcher for the current trusted Pi session.
- On enable, handles current tracked edits and then watches all project files.
- Debounces changes, runs one hidden implementation pass at a time, and converges until no further edit is needed.

## Rules

- User declarations, signatures, structs, classes, enums, templates, and type layouts are immutable.
- Pi may only add or update matching C/C++ definitions in existing implementation files and add necessary implementation includes.
- Pi never creates files, changes declarations, invents APIs or helpers, adds workarounds, or performs unrelated cleanup.
- Automatic passes cannot run shell commands, builds, tests, formatters, benchmarks, Clang, or compile databases.
- If implementation is impossible, Pi may add one concise `// @TODO:` or `// @NOTE:` at the relevant existing implementation location.

The watcher is language-neutral; only its current implementation policy is C/C++. The rules are agent-enforced because `pi-fe` intentionally has no parser or compiler frontend. Ordinary Pi turns remain unchanged.
