import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import piFe, { AUTOMATIC_PREFIX, IMPLEMENTATION_POLICY } from "../src/index.js";

interface Harness {
  commands: Map<string, { handler: (args: string, ctx: any) => Promise<void> }>;
  messages: Array<{ message: any; options: any }>;
  notifications: string[];
  statuses: Array<string | undefined>;
  activeToolChanges: string[][];
  transformers: Array<(markdown: string, context: any) => string>;
  execCalls: string[][];
  activeTools: () => string[];
  emit: (name: string, event: any, ctx?: any) => Promise<any[]>;
  pi: any;
}

function harness(diff = "", failFirstToolChange = false): Harness {
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const messages: Array<{ message: any; options: any }> = [];
  const notifications: string[] = [];
  const statuses: Array<string | undefined> = [];
  const activeToolChanges: string[][] = [];
  const transformers: Array<(markdown: string, context: any) => string> = [];
  const execCalls: string[][] = [];
  let shouldFailToolChange = failFirstToolChange;
  let activeTools = ["read", "bash", "edit", "write", "questionnaire"];
  const allTools = [...activeTools, "grep", "find", "ls"].map((name) => ({ name }));
  const pi = {
    registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
      commands.set(name, command);
    },
    on(name: string, handler: (event: any, ctx: any) => any) {
      const entries = handlers.get(name) ?? [];
      entries.push(handler);
      handlers.set(name, entries);
    },
    sendMessage(message: any, options: any) {
      messages.push({ message, options });
    },
    getActiveTools() {
      return [...activeTools];
    },
    getAllTools() {
      return allTools;
    },
    setActiveTools(tools: string[]) {
      if (shouldFailToolChange) {
        shouldFailToolChange = false;
        throw new Error("tool activation failed");
      }
      activeTools = [...tools];
      activeToolChanges.push([...tools]);
    },
    registerMarkdownTransformer(transformer: (markdown: string, context: any) => string) {
      transformers.push(transformer);
    },
    async exec(_command: string, args: string[]) {
      execCalls.push(args);
      return { stdout: diff, stderr: "", code: 0, killed: false };
    },
  };
  const emit = async (name: string, event: any, ctx: any = {}): Promise<any[]> => {
    const output: any[] = [];
    for (const handler of handlers.get(name) ?? []) output.push(await handler(event, ctx));
    return output;
  };
  return {
    commands,
    messages,
    notifications,
    statuses,
    activeToolChanges,
    transformers,
    execCalls,
    activeTools: () => [...activeTools],
    emit,
    pi,
  };
}

function extensionContext(state: Harness, root: string, trusted = true) {
  return {
    cwd: root,
    isProjectTrusted: () => trusted,
    ui: {
      notify: (message: string) => state.notifications.push(message),
      setStatus: (_key: string, value: string | undefined) => state.statuses.push(value),
    },
  };
}

async function workspace(): Promise<string> {
  return mkdtemp(resolve(tmpdir(), "pi-fe-index-"));
}

function automaticMessage(paths: string[], kind: "initial" | "changes" = "changes") {
  return {
    role: "custom",
    customType: "pi-fe-implementation",
    content: `${AUTOMATIC_PREFIX}\nkind=${kind}\npaths:\n${paths.join("\n")}`,
    display: false,
    details: { kind, paths },
  };
}

function toolCall(toolCallId: string, toolName: string, input: Record<string, unknown>) {
  return { type: "tool_call", toolCallId, toolName, input };
}

function toolResult(toolCallId: string, toolName: string, isError = false) {
  return {
    type: "tool_result",
    toolCallId,
    toolName,
    input: {},
    content: [{ type: "text", text: "result" }],
    details: undefined,
    isError,
  };
}

async function start(state: Harness, root: string) {
  const ctx = extensionContext(state, root);
  piFe(state.pi);
  await state.commands.get("pi-fe")!.handler("", ctx);
  return ctx;
}

async function startAutomatic(state: Harness, paths: string[]) {
  const message = automaticMessage(paths);
  await state.emit("message_start", { type: "message_start", message });
  return message;
}

describe("Pi extension", () => {
  it("registers an idle toggle and always queues exactly one hidden bootstrap pass", async () => {
    const state = harness();
    piFe(state.pi);
    const cwd = await workspace();
    const ctx = extensionContext(state, cwd);

    expect([...state.commands.keys()]).toEqual(["pi-fe"]);
    expect(state.messages).toEqual([]);
    expect(state.activeToolChanges).toEqual([]);
    await state.emit("session_start", { type: "session_start", reason: "startup" }, ctx);

    await state.commands.get("pi-fe")!.handler("", ctx);
    expect(state.notifications).toEqual(["pi-fe:on"]);
    expect(state.statuses).toEqual(["pi-fe:on"]);
    expect(state.messages).toHaveLength(1);
    expect(state.activeTools()).toEqual(["read", "edit", "questionnaire", "grep", "find", "ls"]);
    expect(state.messages[0]).toEqual({
      message: {
        customType: "pi-fe-implementation",
        content: `${AUTOMATIC_PREFIX}\nkind=initial\npaths:\n.`,
        display: false,
        details: { kind: "initial", paths: ["."] },
      },
      options: { triggerTurn: true, deliverAs: "followUp" },
    });
    expect(state.execCalls).toEqual([]);

    await state.commands.get("pi-fe")!.handler("", ctx);
    expect(state.notifications.at(-1)).toBe("pi-fe:off");
    expect(state.statuses.at(-1)).toBeUndefined();
    expect(state.activeTools()).toEqual(["read", "bash", "edit", "write", "questionnaire"]);
    await state.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
  });

  it("refuses untrusted projects without changing tools or starting work", async () => {
    const state = harness();
    piFe(state.pi);
    const ctx = extensionContext(state, await workspace(), false);
    await state.commands.get("pi-fe")!.handler("", ctx);
    expect(state.notifications).toEqual(["pi-fe:untrusted"]);
    expect(state.messages).toEqual([]);
    expect(state.activeToolChanges).toEqual([]);
  });

  it("injects current snapshots and diff transiently and isolates tools and prose", async () => {
    const cwd = await workspace();
    await writeFile(resolve(cwd, "build.c"), "typedef struct { int count; } seb_files;\n");
    const state = harness("diff --git a/build.c b/build.c\n+typedef struct");
    const ctx = await start(state, cwd);
    const message = await startAutomatic(state, ["build.c"]);

    expect(state.activeTools()).toEqual(["read", "edit", "questionnaire", "grep", "find", "ls"]);
    expect(state.execCalls.at(-1)).toEqual(["diff", "--no-ext-diff", "--unified=0", "HEAD", "--", "build.c"]);
    const transformed = (await state.emit("context", { type: "context", messages: [message] }, ctx))[0];
    const content = transformed.messages[0].content as string;
    expect(content).toContain(IMPLEMENTATION_POLICY);
    expect(content).toContain("PI-FE CURRENT PASS SNAPSHOTS");
    expect(content).toContain("typedef struct { int count; } seb_files;");
    expect(content).toContain("CURRENT ZERO-CONTEXT GIT DIFF");
    expect(state.messages[0]!.message.content).not.toContain("typedef struct");

    expect(state.transformers[0]!("automatic prose", { messageType: "assistant" })).toBe("");
    const assistant = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private" },
        { type: "text", text: "explanation" },
        { type: "toolCall", id: "1", name: "edit", arguments: {} },
      ],
    };
    const hidden = (await state.emit("message_end", { type: "message_end", message: assistant }, ctx))[0];
    expect(hidden.message.content).toEqual([{ type: "toolCall", id: "1", name: "edit", arguments: {} }]);
    expect((await state.emit("tool_call", toolCall("bash", "bash", { command: "./build.sh" }), ctx))[0]).toMatchObject({ block: true });
    expect((await state.emit("tool_call", toolCall("write", "write", { path: "new.c", content: "" }), ctx))[0]).toMatchObject({ block: true });

    await state.emit("message_start", { type: "message_start", message: { role: "user", content: "normal" } }, ctx);
    expect(state.activeTools()).toEqual(["read", "bash", "edit", "write", "questionnaire"]);
    expect(state.transformers[0]!("normal prose", { messageType: "assistant" })).toBe("normal prose");
    expect((await state.emit("context", { type: "context", messages: [message] }, ctx))[0]).toBeUndefined();
    expect((await state.emit("tool_call", toolCall("normal-bash", "bash", { command: "./build.sh" }), ctx))[0]).toBeUndefined();
    expect((await state.emit("tool_call", toolCall("normal-write", "write", { path: "new.c", content: "" }), ctx))[0]).toBeUndefined();
    await state.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
  });

  it("rejects an old-pass edit and accepts current nested type uses after a new read", async () => {
    const oldLayout = `typedef struct {\n    char sources[8][64];\n    int sources_count;\n} seb_module;\n\nbool add(seb_module *module) {\n    return module->sources_count < 8;\n}\n`;
    const nestedLayout = `typedef struct {\n    char paths[8][64];\n    int count;\n} seb_files;\n\ntypedef struct {\n    seb_files sources;\n    seb_files outputs;\n} seb_module;\n\nbool add(seb_module *module) {\n    return module->sources.count < 8 && module->sources.paths[0][0] == 0;\n}\n`;
    const cwd = await workspace();
    const file = resolve(cwd, "build.c");
    await writeFile(file, oldLayout);
    const state = harness();
    const ctx = await start(state, cwd);
    await startAutomatic(state, ["build.c"]);

    expect((await state.emit("tool_call", toolCall("read-old", "read", { path: "build.c" }), ctx))[0]).toBeUndefined();
    expect((await state.emit("tool_result", toolResult("read-old", "read"), ctx))[0]).toBeUndefined();
    await state.emit("agent_settled", { type: "agent_settled" }, ctx);

    await writeFile(file, nestedLayout);
    await new Promise((resolveWait) => setTimeout(resolveWait, 450));
    expect(state.messages[1]!.message.details).toEqual({ kind: "changes", paths: ["build.c"] });
    const currentMessage = { role: "custom", ...state.messages[1]!.message };
    await state.emit("message_start", { type: "message_start", message: currentMessage }, ctx);
    const currentContext = (await state.emit("context", { type: "context", messages: [currentMessage] }, ctx))[0];
    expect(currentContext.messages[0].content).toContain("module->sources.count");
    expect(currentContext.messages[0].content).toContain("module->sources.paths");

    const stale = (await state.emit("tool_call", toolCall("stale-edit", "edit", {
      path: "build.c",
      edits: [{ oldText: "module->sources_count", newText: "module->sources.count" }],
    }), ctx))[0];
    expect(stale).toMatchObject({ block: true });
    expect(stale.reason).toContain("replacement text is not present");

    await state.emit("tool_call", toolCall("read-current", "read", { path: "build.c" }), ctx);
    await state.emit("tool_result", toolResult("read-current", "read"), ctx);
    expect((await state.emit("tool_call", toolCall("current-edit", "edit", {
      path: "build.c",
      edits: [{ oldText: "module->sources.count < 8", newText: "module->sources.count <= 8" }],
    }), ctx))[0]).toBeUndefined();

    const edited = nestedLayout.replace("module->sources.count < 8", "module->sources.count <= 8");
    await writeFile(file, edited);
    await state.emit("tool_result", toolResult("current-edit", "edit"), ctx);
    const second = (await state.emit("tool_call", toolCall("second-edit", "edit", {
      path: "build.c",
      edits: [{ oldText: "module->sources.count <= 8", newText: "module->sources.count < 8" }],
    }), ctx))[0];
    expect(second).toMatchObject({ block: true });
    expect(second.reason).toContain("not read in this automatic pass");

    expect((await readFile(file, "utf8")).split("\n").slice(0, 9).join("\n")).toBe(nestedLayout.split("\n").slice(0, 9).join("\n"));
    await state.emit("agent_settled", { type: "agent_settled" }, ctx);
    expect(state.messages[2]!.message.details).toEqual({ kind: "changes", paths: ["build.c"] });
    await state.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
  });

  it("accepts one complete implementation reconciliation while preserving nested declarations byte-for-byte", async () => {
    const declarations = `typedef struct {\n    char paths[64][8];\n    int count;\n} seb_files;\n\ntypedef struct {\n    seb_files sources;\n    seb_files outputs;\n} seb_module;\n`;
    const implementation = `\nbool se_module_add_file(seb_module *module, const char *path) {\n    size_t length = strlen(path);\n    if ((size_t)module->sources_count >= sizeof(module->sources) / sizeof(module->sources[0])) {\n        return false;\n    }\n    memcpy(module->sources[module->sources_count], path, length + 1);\n    ++module->sources_count;\n    return true;\n}\n`;
    const edits = [
      {
        oldText: "if ((size_t)module->sources_count >= sizeof(module->sources) / sizeof(module->sources[0])) {",
        newText: "if ((size_t)module->sources.count >= sizeof(module->sources.paths) / sizeof(module->sources.paths[0])) {",
      },
      {
        oldText: "memcpy(module->sources[module->sources_count], path, length + 1);",
        newText: "memcpy(module->sources.paths[module->sources.count], path, length + 1);",
      },
      { oldText: "++module->sources_count;", newText: "++module->sources.count;" },
    ];
    const cwd = await workspace();
    const file = resolve(cwd, "build.c");
    await writeFile(file, declarations + implementation);
    const state = harness();
    const ctx = await start(state, cwd);
    await startAutomatic(state, ["build.c"]);

    expect((await state.emit("tool_call", toolCall("reconcile", "edit", { path: "build.c", edits }), ctx))[0]).toBeUndefined();
    let reconciled = declarations + implementation;
    for (const edit of edits) reconciled = reconciled.replace(edit.oldText, edit.newText);
    await writeFile(file, reconciled);
    await state.emit("tool_result", toolResult("reconcile", "edit"), ctx);

    const result = await readFile(file, "utf8");
    expect(result.slice(0, declarations.length)).toBe(declarations);
    expect(result).toContain("module->sources.count");
    expect(result).toContain("module->sources.paths[module->sources.count]");
    expect(result).not.toContain("sources_count");
    expect(result).not.toContain("module->sources[");
    await state.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
  });

  it("invalidates reads changed during or after execution", async () => {
    const cwd = await workspace();
    const file = resolve(cwd, "source.cpp");
    await writeFile(file, "int value() { return 1; }\n");
    const state = harness();
    const ctx = await start(state, cwd);
    await startAutomatic(state, ["source.cpp"]);

    await state.emit("tool_call", toolCall("moving-read", "read", { path: "source.cpp" }), ctx);
    await writeFile(file, "int value() { return 2; }\n");
    const staleRead = (await state.emit("tool_result", toolResult("moving-read", "read"), ctx))[0];
    expect(staleRead).toMatchObject({ isError: true });
    expect(staleRead.content[0].text).toContain("changed during the read");

    await state.emit("tool_call", toolCall("stable-read", "read", { path: "source.cpp" }), ctx);
    await state.emit("tool_result", toolResult("stable-read", "read"), ctx);
    await writeFile(file, "int value() { return 3; }\n");
    const staleEdit = (await state.emit("tool_call", toolCall("after-read-edit", "edit", {
      path: "source.cpp",
      edits: [{ oldText: "return 2", newText: "return 3" }],
    }), ctx))[0];
    expect(staleEdit).toMatchObject({ block: true });
    expect(staleEdit.reason).toContain("file changed");
    await state.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
  });

  it("reserves edits and rejects missing, symlinked, and outside-root targets", async () => {
    const cwd = await workspace();
    const outside = await workspace();
    await writeFile(resolve(cwd, "source.c"), "int value(void) { return 1; }\n");
    await writeFile(resolve(outside, "outside.c"), "int outside(void);\n");
    await symlink(resolve(outside, "outside.c"), resolve(cwd, "linked.c"));
    await symlink(outside, resolve(cwd, "linked-dir"), "dir");
    const state = harness();
    const ctx = await start(state, cwd);
    await startAutomatic(state, ["source.c"]);
    const input = { path: "source.c", edits: [{ oldText: "return 1", newText: "return 2" }] };
    const first = await state.emit("tool_call", toolCall("parallel-1", "edit", input), ctx);
    const second = await state.emit("tool_call", toolCall("parallel-2", "edit", input), ctx);
    expect(first[0]).toBeUndefined();
    expect(second[0]).toMatchObject({ block: true });
    expect(second[0].reason).toContain("reserved");

    for (const [id, path] of [
      ["missing", "missing.c"],
      ["linked", "linked.c"],
      ["linked-directory", "linked-dir/outside.c"],
      ["outside", resolve(outside, "outside.c")],
    ] as const) {
      const result = (await state.emit("tool_call", toolCall(id, "edit", {
        path,
        edits: [{ oldText: "int", newText: "long" }],
      }), ctx))[0];
      expect(result).toMatchObject({ block: true });
      expect(result.reason).toContain("existing non-symlink regular file inside the project");
    }
    await state.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
  });

  it("marks deleted, oversized, binary, and aggregate-overflow snapshots as read-required", async () => {
    const cwd = await workspace();
    await writeFile(resolve(cwd, "large.txt"), "x".repeat(128 * 1024 + 1));
    await writeFile(resolve(cwd, "binary.dat"), Buffer.from([0, 1, 2, 3]));
    for (let index = 0; index < 5; index += 1) {
      await writeFile(resolve(cwd, `part-${index}.txt`), `${index}`.repeat(128 * 1024));
    }
    const state = harness();
    const ctx = await start(state, cwd);
    const paths = ["deleted.c", "large.txt", "binary.dat", ...Array.from({ length: 5 }, (_, index) => `part-${index}.txt`)];
    const message = await startAutomatic(state, paths);
    const content = (await state.emit("context", { type: "context", messages: [message] }, ctx))[0].messages[0].content as string;
    expect(content).toContain('FILE "deleted.c": deleted');
    expect(content).toContain('FILE "large.txt": read-required (larger than 131072 bytes)');
    expect(content).toContain('FILE "binary.dat": read-required (non-text content)');
    expect(content).toContain("snapshot total exceeds 524288 bytes");
    await state.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
  });

  it("coalesces changes during a run and stops after a stable convergence pass", async () => {
    const cwd = await workspace();
    const state = harness();
    const ctx = await start(state, cwd);
    expect(state.messages).toHaveLength(1);

    await Promise.all([
      writeFile(resolve(cwd, "value.hpp"), "struct Value { int count; };\n"),
      writeFile(resolve(cwd, "value.cpp"), "int value() { return 1; }\n"),
      writeFile(resolve(cwd, "contract.md"), "contract\n"),
    ]);
    await new Promise((resolveWait) => setTimeout(resolveWait, 450));
    expect(state.messages).toHaveLength(1);

    await state.emit("agent_settled", { type: "agent_settled" }, ctx);
    expect(state.messages).toHaveLength(2);
    expect(state.messages[1]!.message.details).toEqual({
      kind: "changes",
      paths: ["contract.md", "value.cpp", "value.hpp"],
    });
    await state.emit("message_start", { type: "message_start", message: { role: "custom", ...state.messages[1]!.message } }, ctx);
    await state.emit("agent_settled", { type: "agent_settled" }, ctx);
    expect(state.messages).toHaveLength(2);
    await state.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
  });

  it("restores the exact tool set after settle, disable, shutdown, error, and cancellation", async () => {
    const cwd = await workspace();
    await mkdir(resolve(cwd, "src"));
    await writeFile(resolve(cwd, "src", "value.c"), "int value(void);\n");
    const state = harness();
    const ctx = await start(state, cwd);
    const original = ["read", "bash", "edit", "write", "questionnaire"];

    await startAutomatic(state, ["src/value.c"]);
    expect(state.activeTools()).toContain("grep");
    await state.emit("agent_settled", { type: "agent_settled" }, ctx);
    expect(state.activeTools()).toEqual(original);

    await startAutomatic(state, ["src/value.c"]);
    await state.emit("agent_end", { type: "agent_end", messages: [] }, ctx);
    expect(state.activeTools()).toEqual(original);

    await startAutomatic(state, ["src/value.c"]);
    await state.emit("message_start", { type: "message_start", message: { role: "user", content: "cancel" } }, ctx);
    expect(state.activeTools()).toEqual(original);

    await startAutomatic(state, ["src/value.c"]);
    await state.commands.get("pi-fe")!.handler("", ctx);
    expect(state.activeTools()).toEqual(original);

    await state.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
    expect(state.activeTools()).toEqual(original);

    const errorState = harness("", true);
    const errorRoot = await workspace();
    await writeFile(resolve(errorRoot, "value.c"), "int value(void);\n");
    piFe(errorState.pi);
    const errorContext = extensionContext(errorState, errorRoot);
    await expect(errorState.commands.get("pi-fe")!.handler("", errorContext)).rejects.toThrow("tool activation failed");
    expect(errorState.activeTools()).toEqual(original);
    await errorState.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, errorContext);
  });

  it("waits for an ordinary run to settle before preparing automatic tools", async () => {
    const state = harness();
    const cwd = await workspace();
    const ctx = extensionContext(state, cwd);
    piFe(state.pi);

    await state.emit("agent_start", { type: "agent_start" }, ctx);
    await state.commands.get("pi-fe")!.handler("", ctx);
    expect(state.messages).toEqual([]);
    expect(state.activeTools()).toEqual(["read", "bash", "edit", "write", "questionnaire"]);

    await state.emit("agent_settled", { type: "agent_settled" }, ctx);
    expect(state.messages).toHaveLength(1);
    expect(state.activeTools()).toEqual(["read", "edit", "questionnaire", "grep", "find", "ls"]);

    await startAutomatic(state, ["."]);
    await state.emit("agent_settled", { type: "agent_settled" }, ctx);
    expect(state.activeTools()).toEqual(["read", "bash", "edit", "write", "questionnaire"]);
    await state.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
  });

  it("defines complete type-change reconciliation without broad or invented work", () => {
    for (const term of ["structs", "classes", "unions", "enums", "fields", "bases", "templates", "typedefs", "constants", "authoritative signatures"]) {
      expect(IMPLEMENTATION_POLICY).toContain(term);
    }
    for (const term of ["member and array accesses", "initializers", "constructors", "destructors", "calls", "necessary includes"]) {
      expect(IMPLEMENTATION_POLICY).toContain(term);
    }
    expect(IMPLEMENTATION_POLICY).toContain("module->sources.count");
    expect(IMPLEMENTATION_POLICY).toContain("module->sources.paths");
    expect(IMPLEMENTATION_POLICY).toContain("Ignore older file contents and tool results");
    expect(IMPLEMENTATION_POLICY).toContain("targeted exact-identifier discovery");
    expect(IMPLEMENTATION_POLICY).toContain("Do not inspect TODO files");
    expect(IMPLEMENTATION_POLICY).toContain("broad project audits");
    expect(IMPLEMENTATION_POLICY).toContain("Never invent semantics");
    expect(IMPLEMENTATION_POLICY).toContain("// @TODO:");
    expect(IMPLEMENTATION_POLICY).toContain("// @NOTE:");
  });
});
