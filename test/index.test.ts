import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import piFe from "../src/index.js";

const execFileAsync = promisify(execFile);

async function repository(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "pi-fe-index-"));
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await writeFile(resolve(root, "source.cpp"), "int value() { return 1; }\n");
  await execFileAsync("git", ["add", "source.cpp"], { cwd: root });
  return root;
}

function context(root: string, branch: unknown[] = []) {
  return {
    cwd: root,
    isProjectTrusted: () => true,
    sessionManager: { getBranch: () => branch },
  };
}

describe("Pi extension integration", () => {
  it("enforces lifecycle, ownership, single finalizer calls, prose suppression, and terminating JSON", async () => {
    const root = await repository();
    const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
    const tools = new Map<string, any>();
    const builtins = ["read", "grep", "find", "ls", "bash", "edit", "write"].map((name) => ({
      name, description: name, parameters: {}, promptGuidelines: [],
      sourceInfo: { path: `<builtin:${name}>`, source: "builtin", scope: "temporary", origin: "top-level" },
    }));
    const transformers: Array<(markdown: string, context: any) => string> = [];
    const active: string[][] = [];
    const entries: unknown[] = [];
    const packageRoot = resolve(import.meta.dirname, "..");
    const pi = {
      on(name: string, handler: (event: any, ctx: any) => any) {
        const values = handlers.get(name) ?? [];
        values.push(handler);
        handlers.set(name, values);
      },
      registerTool(tool: any) { tools.set(tool.name, tool); },
      registerMarkdownTransformer(transformer: (markdown: string, context: any) => string) { transformers.push(transformer); },
      getAllTools() {
        return [...builtins, ...[...tools.values()].map((tool) => ({
          ...tool,
          sourceInfo: { path: resolve(packageRoot, "src", "index.ts"), source: "extension", scope: "temporary", origin: "package" },
        }))];
      },
      getActiveTools() { return active.at(-1) ?? builtins.map((tool) => tool.name); },
      setActiveTools(names: string[]) { active.push(names); },
      appendEntry(type: string, data: unknown) { entries.push({ type, data }); },
      sendMessage() {},
      async exec(command: string, args: string[], options: { cwd?: string }) {
        try {
          const result = await execFileAsync(command, args, { cwd: options.cwd, encoding: "utf8" });
          return { stdout: result.stdout, stderr: result.stderr, code: 0, killed: false };
        } catch (error) {
          const failure = error as Error & { stdout?: string; stderr?: string; code?: number };
          return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", code: failure.code ?? 1, killed: false };
        }
      },
    };
    piFe(pi as never);
    const ctx = context(root);
    for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
    expect(active.at(-1)).toEqual(["read", "grep", "find", "ls", "cxx_contract", "cxx_check", "cxx_apply", "cxx_todo", "cxx_finalize"]);
    expect(transformers[0]?.("prose", { messageType: "assistant", isStreaming: false })).toBe("");

    const gate = handlers.get("tool_call")![0]!;
    await expect(gate({ toolName: "bash" }, ctx)).resolves.toMatchObject({ block: true });
    await expect(gate({ toolName: "read" }, ctx)).resolves.toBeUndefined();
    const mixedBranch = [{
      type: "message",
      message: { role: "assistant", content: [
        { type: "toolCall", id: "1", name: "cxx_finalize", arguments: {} },
        { type: "toolCall", id: "2", name: "read", arguments: {} },
      ] },
    }];
    await expect(gate({ toolName: "cxx_finalize" }, context(root, mixedBranch))).resolves.toMatchObject({
      block: true, terminate: true,
    });

    const finalize = tools.get("cxx_finalize");
    const result = await finalize.execute("id", {
      generation: 0, status: "unchanged", changed: [], checks: [], todos: [], diagnostics: [],
    });
    expect(result.terminate).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ status: "unchanged" });

    for (const handler of handlers.get("agent_settled") ?? []) await handler({}, ctx);
    expect(entries).toHaveLength(0);
    for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
  });
});
