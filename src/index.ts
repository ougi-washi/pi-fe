import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  MessageEndEvent,
} from "@earendil-works/pi-coding-agent";
import { ProjectWatcher } from "./watcher.js";

export const AUTOMATIC_PREFIX = "PI_FE_AUTOMATIC_IMPLEMENTATION";

export const IMPLEMENTATION_POLICY = `
PI-FE C/C++ IMPLEMENTATION MODE

The reported paths and diff are the complete task boundary. This is not a project review, TODO task, planning task, bug sweep, or verification run. Start with the changed paths. Identify only added or changed C/C++ function declarations, find their matching existing implementation file, and implement them. Inspect only directly related declarations, definitions, types, and call sites.

User-authored structs, classes, unions, enums, fields, bases, templates, declarations, and authoritative signatures are immutable inputs. Headers and other user-provided declarations are authoritative. Never edit them or alter user-owned type layout.

You may only:
- fill or update a matching function, method, constructor, or destructor body in an existing C or C++ implementation file;
- add a missing out-of-line definition to an existing implementation file when it maps directly and unambiguously to an authoritative declaration;
- synchronize an implementation-side definition signature exactly to its authoritative declaration;
- add a strictly necessary implementation-file include.

Do not inspect TODO files, choose project tasks, read Git history, perform repository-wide scans, or run shell commands, builds, tests, linters, formatters, benchmarks, compile databases, Clang analysis, or generated command lists. Do not create files, headers, tests, documentation, configuration, APIs, helper types, unrelated symbols, scaffolding, abstractions, fallbacks, speculative branches, logging, retries, placeholders, test-only behavior, compatibility workarounds, or unrelated cleanup.

Always use the simplest, most direct, and most efficient implementation supported by the existing code and declarations. Never implement a workaround. If implementation is genuinely impossible or presents a serious unresolved concern, add exactly one concise // @TODO: or // @NOTE: beside the relevant existing implementation location. If there is no existing implementation file or unambiguous location, leave the declaration untouched.

Use tools as needed. Emit no explanatory prose.
`.trim();

type AssistantMessage = Extract<MessageEndEvent["message"], { role: "assistant" }>;

interface RuntimeState {
  watcher: ProjectWatcher | undefined;
  pendingPaths: Set<string>;
  automaticOutstanding: boolean;
  automaticRun: boolean;
}

interface AutomaticBatch {
  kind: "initial" | "changes";
  paths: string[];
  diff?: string;
}

async function initialBatch(pi: ExtensionAPI, root: string): Promise<AutomaticBatch | undefined> {
  const names = await pi.exec("git", ["diff", "--name-only", "-z", "HEAD", "--"], { cwd: root, timeout: 5000 });
  if (names.code !== 0) return undefined;
  const paths = names.stdout.split("\0").filter(Boolean).sort();
  if (paths.length === 0) return undefined;
  const result = await pi.exec("git", ["diff", "--no-ext-diff", "--unified=0", "HEAD", "--", ...paths], {
    cwd: root,
    timeout: 5000,
  });
  const output = result.code === 0 ? result.stdout.trim() : "";
  const diff = output.length > 16000 ? `${output.slice(0, 16000)}\n[diff truncated]` : output;
  return { kind: "initial", paths, ...(diff ? { diff } : {}) };
}

function automaticContent(batch: AutomaticBatch): string {
  const paths = batch.paths.join("\n");
  return `${AUTOMATIC_PREFIX}\nkind=${batch.kind}\npaths:\n${paths}${batch.diff ? `\ndiff:\n${batch.diff}` : ""}`;
}

export function isAutomaticPrompt(event: Pick<BeforeAgentStartEvent, "prompt">): boolean {
  return event.prompt.startsWith(AUTOMATIC_PREFIX);
}

export function stripAutomaticProse(message: AssistantMessage): AssistantMessage {
  return {
    ...message,
    content: message.content.filter((block) => block.type === "toolCall"),
  };
}

export default function piFe(pi: ExtensionAPI): void {
  const state: RuntimeState = {
    watcher: undefined,
    pendingPaths: new Set<string>(),
    automaticOutstanding: false,
    automaticRun: false,
  };

  const sendAutomatic = (batch: AutomaticBatch): void => {
    if (!state.watcher || state.automaticOutstanding) return;
    state.automaticOutstanding = true;
    pi.sendMessage(
      {
        customType: "pi-fe-implementation",
        content: automaticContent(batch),
        display: false,
        details: { kind: batch.kind, paths: batch.paths },
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  };

  const sendPending = (): void => {
    if (!state.watcher || state.automaticOutstanding || state.pendingPaths.size === 0) return;
    const paths = [...state.pendingPaths].sort();
    state.pendingPaths.clear();
    sendAutomatic({ kind: "changes", paths });
  };

  const stop = async (ctx?: Pick<ExtensionCommandContext, "ui">, announce = false): Promise<void> => {
    const watcher = state.watcher;
    state.watcher = undefined;
    state.pendingPaths.clear();
    state.automaticOutstanding = false;
    state.automaticRun = false;
    await watcher?.close();
    if (ctx && watcher) {
      ctx.ui.setStatus("pi-fe", undefined);
      if (announce) ctx.ui.notify("pi-fe:off", "info");
    }
  };

  pi.registerCommand("pi-fe", {
    description: "Toggle continuous implementation watching",
    handler: async (_args, ctx) => {
      if (state.watcher) {
        await stop(ctx, true);
        return;
      }
      if (!ctx.isProjectTrusted()) {
        ctx.ui.notify("pi-fe:untrusted", "warning");
        return;
      }

      const watcher = new ProjectWatcher({
        root: ctx.cwd,
        onPaths: (paths) => {
          for (const path of paths) state.pendingPaths.add(path);
          sendPending();
        },
        onError: () => ctx.ui.notify("pi-fe:watch-error", "error"),
      });
      state.watcher = watcher;
      try {
        await watcher.start();
      } catch (error) {
        await stop();
        ctx.ui.notify("pi-fe:error", "error");
        throw error;
      }

      ctx.ui.setStatus("pi-fe", "pi-fe:on");
      ctx.ui.notify("pi-fe:on", "info");
      const batch = await initialBatch(pi, ctx.cwd);
      if (batch) sendAutomatic(batch);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    await stop(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await stop(ctx);
  });

  pi.on("before_agent_start", (event) => {
    state.automaticRun = isAutomaticPrompt(event);
    if (!state.automaticRun) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${IMPLEMENTATION_POLICY}` };
  });

  pi.on("message_end", (event) => {
    if (!state.automaticRun || event.message.role !== "assistant") return;
    return { message: stripAutomaticProse(event.message) };
  });

  pi.on("tool_call", (event) => {
    if (state.automaticRun && event.toolName === "bash") {
      return { block: true, reason: "pi-fe automatic turns do not run shell commands" };
    }
  });

  pi.registerMarkdownTransformer((markdown, context) => {
    if (state.automaticRun && (context.messageType === "assistant" || context.messageType === "assistant-thinking")) return "";
    return markdown;
  });

  pi.on("agent_settled", () => {
    if (!state.automaticOutstanding) return;
    state.automaticOutstanding = false;
    state.automaticRun = false;
    sendPending();
  });
}
