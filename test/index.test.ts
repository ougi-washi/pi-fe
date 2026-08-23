import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import piFe, { AUTOMATIC_PREFIX, IMPLEMENTATION_POLICY } from "../src/index.js";

interface Harness {
  commands: Map<string, { handler: (args: string, ctx: any) => Promise<void> }>;
  handlers: Map<string, Array<(event: any, ctx: any) => any>>;
  messages: Array<{ message: any; options: any }>;
  notifications: string[];
  statuses: Array<string | undefined>;
  activeToolChanges: string[][];
  transformers: Array<(markdown: string, context: any) => string>;
  pi: any;
}

function harness(gitNames = "value.hpp\0", gitDiff = "+int value();\n"): Harness {
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const messages: Array<{ message: any; options: any }> = [];
  const notifications: string[] = [];
  const statuses: Array<string | undefined> = [];
  const activeToolChanges: string[][] = [];
  const transformers: Array<(markdown: string, context: any) => string> = [];
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
    setActiveTools(tools: string[]) {
      activeToolChanges.push(tools);
    },
    registerMarkdownTransformer(transformer: (markdown: string, context: any) => string) {
      transformers.push(transformer);
    },
    async exec(_command: string, args: string[]) {
      if (args.includes("--name-only")) return { stdout: gitNames, stderr: "", code: 0, killed: false };
      return { stdout: gitDiff, stderr: "", code: 0, killed: false };
    },
  };
  return { commands, handlers, messages, notifications, statuses, activeToolChanges, transformers, pi };
}

function context(root: string, trusted = true) {
  return {
    cwd: root,
    isProjectTrusted: () => trusted,
    ui: {
      notify: (message: string) => testState.notifications.push(message),
      setStatus: (_key: string, value: string | undefined) => testState.statuses.push(value),
    },
  };
}

let testState: Harness;

async function emit(name: string, event: any, ctx: any = {}): Promise<any[]> {
  const output: any[] = [];
  for (const handler of testState.handlers.get(name) ?? []) output.push(await handler(event, ctx));
  return output;
}

async function root(): Promise<string> {
  return mkdtemp(resolve(tmpdir(), "pi-fe-index-"));
}

describe("Pi extension", () => {
  it("registers an idle /pi-fe toggle, starts one bootstrap pass, and stops cleanly", async () => {
    testState = harness();
    piFe(testState.pi);
    const cwd = await root();
    const ctx = context(cwd);

    expect([...testState.commands.keys()]).toEqual(["pi-fe"]);
    expect(testState.messages).toEqual([]);
    expect(testState.activeToolChanges).toEqual([]);
    await emit("session_start", {}, ctx);

    await testState.commands.get("pi-fe")!.handler("", ctx);
    expect(testState.notifications).toEqual(["pi-fe:on"]);
    expect(testState.statuses).toEqual(["pi-fe:on"]);
    expect(testState.messages).toHaveLength(1);
    expect(testState.messages[0]).toMatchObject({
      message: {
        customType: "pi-fe-implementation",
        display: false,
        details: { kind: "initial", paths: ["value.hpp"] },
      },
      options: { triggerTurn: true, deliverAs: "followUp" },
    });
    expect(testState.messages[0]!.message.content).toContain("paths:\nvalue.hpp");
    expect(testState.messages[0]!.message.content).toContain("diff:\n+int value();");

    await testState.commands.get("pi-fe")!.handler("", ctx);
    expect(testState.notifications.at(-1)).toBe("pi-fe:off");
    expect(testState.statuses.at(-1)).toBeUndefined();
    await emit("session_shutdown", {}, ctx);
  });

  it("refuses to watch an untrusted project", async () => {
    testState = harness();
    piFe(testState.pi);
    const ctx = context(await root(), false);
    await testState.commands.get("pi-fe")!.handler("", ctx);
    expect(testState.notifications).toEqual(["pi-fe:untrusted"]);
    expect(testState.messages).toEqual([]);
  });

  it("waits for a filesystem change when the working tree is clean", async () => {
    testState = harness("");
    piFe(testState.pi);
    const ctx = context(await root());
    await testState.commands.get("pi-fe")!.handler("", ctx);
    expect(testState.messages).toEqual([]);
    await testState.commands.get("pi-fe")!.handler("", ctx);
  });

  it("isolates the implementation policy and prose suppression to automatic turns", async () => {
    testState = harness();
    piFe(testState.pi);
    const ctx = context(await root());
    await testState.commands.get("pi-fe")!.handler("", ctx);

    const normal = (await emit("before_agent_start", { prompt: "Explain this code", systemPrompt: "base" }, ctx))[0];
    expect(normal).toBeUndefined();
    expect(testState.transformers[0]!("normal prose", { messageType: "assistant" })).toBe("normal prose");
    const normalMessage = {
      role: "assistant",
      content: [{ type: "text", text: "normal prose" }],
    };
    expect((await emit("message_end", { message: normalMessage }, ctx))[0]).toBeUndefined();

    const automatic = (await emit("before_agent_start", {
      prompt: testState.messages[0]!.message.content,
      systemPrompt: "base",
    }, ctx))[0];
    expect(automatic.systemPrompt).toBe(`base\n\n${IMPLEMENTATION_POLICY}`);
    expect(testState.transformers[0]!("automatic prose", { messageType: "assistant" })).toBe("");
    expect(testState.transformers[0]!("automatic thinking", { messageType: "assistant-thinking" })).toBe("");
    expect(IMPLEMENTATION_POLICY).toContain("authoritative signatures are immutable inputs");
    expect(IMPLEMENTATION_POLICY).toContain("synchronize an implementation-side definition signature exactly");
    expect(IMPLEMENTATION_POLICY).toContain("Do not create files");
    expect(IMPLEMENTATION_POLICY).toContain("Never implement a workaround");
    expect(IMPLEMENTATION_POLICY).toContain("complete task boundary");
    expect(IMPLEMENTATION_POLICY).toContain("Do not inspect TODO files");
    expect(IMPLEMENTATION_POLICY).toContain("run shell commands, builds, tests");
    expect(IMPLEMENTATION_POLICY).toContain("// @TODO:");
    expect(IMPLEMENTATION_POLICY).toContain("// @NOTE:");
    const automaticMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private" },
        { type: "text", text: "explanation" },
        { type: "toolCall", id: "1", name: "edit", arguments: {} },
      ],
    };
    const transformed = (await emit("message_end", { message: automaticMessage }, ctx))[0];
    expect(transformed.message.content).toEqual([{ type: "toolCall", id: "1", name: "edit", arguments: {} }]);
    expect((await emit("tool_call", { toolName: "bash", input: { command: "./build.sh" } }, ctx))[0]).toEqual({
      block: true,
      reason: "pi-fe automatic turns do not run shell commands",
    });

    await emit("before_agent_start", { prompt: "Normal user request", systemPrompt: "base" }, ctx);
    expect((await emit("tool_call", { toolName: "bash", input: { command: "./build.sh" } }, ctx))[0]).toBeUndefined();

    await testState.commands.get("pi-fe")!.handler("", ctx);
  });

  it("queues changed paths after the active pass settles and then converges", async () => {
    testState = harness();
    piFe(testState.pi);
    const cwd = await root();
    const ctx = context(cwd);
    await testState.commands.get("pi-fe")!.handler("", ctx);
    expect(testState.messages).toHaveLength(1);

    await Promise.all([
      writeFile(resolve(cwd, "value.hpp"), "int value();\n"),
      writeFile(resolve(cwd, "value.cpp"), "int value() { return 1; }\n"),
      writeFile(resolve(cwd, "contract.md"), "value contract\n"),
    ]);
    await new Promise((resolveWait) => setTimeout(resolveWait, 450));
    expect(testState.messages).toHaveLength(1);

    await emit("agent_settled", {}, ctx);
    expect(testState.messages).toHaveLength(2);
    expect(testState.messages[1]!.message.details).toEqual({
      kind: "changes",
      paths: ["contract.md", "value.cpp", "value.hpp"],
    });

    await emit("before_agent_start", { prompt: testState.messages[1]!.message.content, systemPrompt: "base" }, ctx);
    await emit("agent_settled", {}, ctx);
    expect(testState.messages).toHaveLength(2);

    await emit("session_shutdown", {}, ctx);
    expect(testState.statuses.at(-1)).toBeUndefined();
  });
});
