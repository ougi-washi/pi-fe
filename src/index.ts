import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fileURLToPath } from "node:url";
import { realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  withFileMutationQueue,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { ClangEngine, type CommandRunner } from "./clang.js";
import { DEFAULT_CONFIG, loadConfig, type PiFeConfig } from "./config.js";
import { ACTIVE_TOOLS, ACTIVE_TOOL_SET, isContained } from "./policy.js";
import { registerTools, type FinalizeInput } from "./tools.js";
import { TransactionEngine, type ApplyResult } from "./transaction.js";
import { discoverRepositoryRoot, RepositoryWatcher, type ChangeBatch, type WatchCommandRunner } from "./watcher.js";

const STRICT_POLICY = `
IDENTITY=PI_FOR_ENGINEERS
MODE=CXX_IMPL_STRICT
OUTPUT=TOOL_CALLS_ONLY
PROSE=DENY
CHAIN_OF_THOUGHT=DENY
EVIDENCE=STRUCTURED_TOOL_ARGUMENTS
HEADER_WRITE=DENY
SOURCE_CREATE=DENY
AMBIGUITY=TODO
SPECULATION=DENY
WORKAROUNDS=DENY
TEST_GENERATION=DENY
STRUCTURE_MUTATION=DENY

PI For Engineers watches all eligible project inputs, but mutates only implementation areas of existing .c/.cpp files. Implement only uniquely contract-backed function, method, constructor, and destructor behavior. Evidence precedence is: header declaration/contract; explicit tests; call-site invariants; sibling implementations; project documentation. Naming is not evidence. Exact out-of-line definitions matching existing header declarations and strictly required source includes are writable. Structures, classes, unions, enums, fields, bases, templates, declarations, signatures, headers, tests used as workarounds, new files, global state, helper types, speculative behavior, fallback behavior, and all workaround code are denied. Quality must come from the existing contract and configured checks; never invent tests, abstractions, logging, retries, defensive branches, placeholder behavior, or unrelated cleanup. Use cxx_contract before mutation, cxx_apply for semantic changes, cxx_todo for ambiguity, cxx_check for configured validation, and cxx_finalize as the final action. If exact implementation is impossible, insert only a technical TODO or NOTE. Never emit assistant prose.`.trim();

interface Runtime {
  root: string;
  config: PiFeConfig;
  clang: ClangEngine;
  transaction: TransactionEngine;
  watcher?: RepositoryWatcher;
  generation: number;
  automaticOutstanding: boolean;
  triggeredGeneration: number;
  latestBatch: ChangeBatch | undefined;
  finalized: boolean;
  mutationResults: ApplyResult[];
  standaloneChecks: ApplyResult["checks"];
  todoComments: string[];
  pipelineFailures: string[];
  enabled: boolean;
}

function compactBatch(batch: ChangeBatch): string {
  return JSON.stringify(batch);
}

function commandRunners(pi: ExtensionAPI): { clang: CommandRunner; watch: WatchCommandRunner } {
  const run = async (command: string, args: string[], options: { cwd: string; signal?: AbortSignal; timeout?: number }) => {
    const result = await pi.exec(command, args, {
      cwd: options.cwd,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.timeout ? { timeout: options.timeout } : {}),
    });
    return { stdout: result.stdout, stderr: result.stderr, code: result.code, killed: result.killed };
  };
  return {
    clang: run,
    watch: async (command, args, options) => run(command, args, options),
  };
}

function stripAssistantProse(message: AssistantMessage): AssistantMessage {
  return {
    ...message,
    content: message.content.filter((block) => block.type === "toolCall"),
  };
}

export default function piFe(pi: ExtensionAPI): void {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  let runtime: Runtime | undefined;
  const requireRuntime = (): Runtime => {
    if (!runtime) throw new Error("pi_fe_session_not_started");
    if (!runtime.enabled) throw new Error("pi_fe_disabled");
    return runtime;
  };

  const enqueueBatch = (batch: ChangeBatch): void => {
    const current = requireRuntime();
    current.generation = batch.generation;
    current.clang.clearCache();
    current.latestBatch = batch;
    if (current.automaticOutstanding) return;
    current.automaticOutstanding = true;
    current.triggeredGeneration = batch.generation;
    current.latestBatch = undefined;
    pi.sendMessage(
      { customType: "pi-fe-cxx-change", content: compactBatch(batch), display: false, details: batch },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  };

  registerTools(pi, {
    get clang() { return requireRuntime().clang; },
    get transaction() { return requireRuntime().transaction; },
    generation: () => requireRuntime().generation,
    noteMutation: (result, todos = []) => {
      const current = requireRuntime();
      current.mutationResults.push(result);
      if (result.status === "todo") current.todoComments.push(...todos);
    },
    noteChecks: (checks) => { requireRuntime().standaloneChecks.push(...checks); },
    noteFailure: (diagnostic) => { requireRuntime().pipelineFailures.push(diagnostic); },
    finalize: (result) => {
      const current = requireRuntime();
      if (current.finalized) throw new Error("duplicate_finalize");
      const commits = current.mutationResults.filter((item) => item.status === "changed" || item.status === "todo");
      const anyCheckFailure = current.standaloneChecks.some((check) => check.status === "fail");
      const expectedStatus = commits.some((item) => item.status === "changed")
        ? "changed"
        : commits.some((item) => item.status === "todo")
          ? "todo"
          : anyCheckFailure || current.pipelineFailures.length > 0
            ? "failed"
            : current.mutationResults.at(-1)?.status === "rejected"
              ? "rejected"
              : "unchanged";
      if (result.status !== expectedStatus) throw new Error("finalize_status_mismatch");
      const actual = [...new Set(commits.flatMap((item) => item.changed))].sort();
      const claimed = [...result.changed].sort();
      if (JSON.stringify(actual) !== JSON.stringify(claimed)) throw new Error("finalize_changed_paths_mismatch");
      const actualChecks = [
        ...current.mutationResults.flatMap((item) => item.checks),
        ...current.standaloneChecks,
      ].map(({ id, status }) => ({ id, status })).sort((left, right) => left.id.localeCompare(right.id));
      const claimedChecks = [...result.checks].sort((left, right) => left.id.localeCompare(right.id));
      if (JSON.stringify(actualChecks) !== JSON.stringify(claimedChecks)) throw new Error("finalize_checks_mismatch");
      if (JSON.stringify([...current.todoComments].sort()) !== JSON.stringify([...result.todos].sort())) throw new Error("finalize_todos_mismatch");
      const actualDiagnostics = [
        ...current.mutationResults.flatMap((item) => item.diagnostics),
        ...current.standaloneChecks.flatMap((check) => check.diagnostics ?? []),
        ...current.pipelineFailures,
      ].slice(0, 16).map((diagnostic) => diagnostic.slice(0, 256)).sort();
      if (JSON.stringify(actualDiagnostics) !== JSON.stringify([...result.diagnostics].sort())) throw new Error("finalize_diagnostics_mismatch");
      current.finalized = true;
    },
  });

  pi.registerMarkdownTransformer((markdown, context) => {
    if (runtime?.enabled && (context.messageType === "assistant" || context.messageType === "assistant-thinking")) return "";
    return markdown;
  });

  pi.on("session_start", async (_event, ctx) => {
    await runtime?.watcher?.close();
    const runners = commandRunners(pi);
    const repository = await discoverRepositoryRoot(ctx.cwd, runners.watch);
    let config = DEFAULT_CONFIG;
    if (ctx.isProjectTrusted()) config = (await loadConfig(repository.root)).config;
    const current: Runtime = {
      root: repository.root,
      config,
      clang: undefined as unknown as ClangEngine,
      transaction: undefined as unknown as TransactionEngine,
      generation: 0,
      automaticOutstanding: false,
      triggeredGeneration: 0,
      latestBatch: undefined,
      finalized: false,
      mutationResults: [],
      standaloneChecks: [],
      todoComments: [],
      pipelineFailures: [],
      enabled: config.enabled && ctx.isProjectTrusted(),
    };
    current.clang = new ClangEngine(current.root, config.compileCommands, runners.clang);
    current.transaction = new TransactionEngine({
      root: current.root,
      config,
      clang: current.clang,
      runner: runners.clang,
      getGeneration: () => current.generation,
      queueMutation: withFileMutationQueue,
      onCommit: (path, hash) => current.watcher?.recordCommitted(path, hash),
    });
    runtime = current;
    if (!current.enabled) {
      pi.setActiveTools(pi.getAllTools().filter((tool) => tool.sourceInfo.source === "builtin").map((tool) => tool.name));
      return;
    }
    pi.setActiveTools([...ACTIVE_TOOLS]);
    current.watcher = await RepositoryWatcher.create({
      root: current.root,
      debounceMs: config.watch.debounceMs,
      include: config.watch.include,
      exclude: config.watch.exclude,
      runner: runners.watch,
      onBatch: async (batch) => { enqueueBatch(batch); },
    });
    await current.watcher.start();
  });

  pi.on("session_shutdown", async () => {
    const current = runtime;
    runtime = undefined;
    await current?.watcher?.close();
  });

  pi.on("before_agent_start", async (event) => {
    if (!runtime?.enabled) return;
    runtime.finalized = false;
    runtime.mutationResults = [];
    runtime.standaloneChecks = [];
    runtime.todoComments = [];
    runtime.pipelineFailures = [];
    pi.setActiveTools([...ACTIVE_TOOLS]);
    return { systemPrompt: `${event.systemPrompt}\n\n${STRICT_POLICY}\nCURRENT_GENERATION=${runtime.generation}` };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!runtime?.enabled) return;
    const assistant = [...ctx.sessionManager.getBranch()].reverse().find((entry) =>
      entry.type === "message" && entry.message.role === "assistant");
    const calls = assistant?.type === "message" && assistant.message.role === "assistant"
      ? assistant.message.content.filter((block) => block.type === "toolCall") : [];
    const batchHasFinalize = calls.some((call) => call.name === "cxx_finalize");
    if (batchHasFinalize && calls.length !== 1) {
      return { block: true, reason: "cxx_finalize_must_be_the_only_tool_call", terminate: true };
    }
    if (runtime.finalized) return { block: true, reason: "run_already_finalized", terminate: true };
    if (!ACTIVE_TOOL_SET.has(event.toolName)) {
      return { block: true, reason: `MODE=CXX_IMPL_STRICT tool_denied=${event.toolName}` };
    }
    const registrations = pi.getAllTools().filter((tool) => tool.name === event.toolName);
    let owned = registrations.length === 1 && registrations[0]!.sourceInfo.source === "builtin" && !event.toolName.startsWith("cxx_");
    if (registrations.length === 1 && event.toolName.startsWith("cxx_")) {
      try {
        const ownerPath = await realpath(registrations[0]!.sourceInfo.path);
        const canonicalPackageRoot = await realpath(packageRoot);
        owned = isContained(canonicalPackageRoot, ownerPath);
      } catch {
        owned = false;
      }
    }
    if (!owned) return { block: true, reason: `tool_ownership_denied=${event.toolName}` };
  });

  pi.on("message_end", async (event) => {
    if (!runtime?.enabled || event.message.role !== "assistant") return;
    return { message: stripAssistantProse(event.message) };
  });

  pi.on("agent_settled", async () => {
    const current = runtime;
    if (!current?.enabled) return;
    if (!current.finalized) {
      pi.appendEntry("pi-fe-run-result", {
        generation: current.generation,
        status: "failed",
        diagnostics: ["cxx_finalize_not_called"],
      });
    }
    if (!current.automaticOutstanding) return;
    current.automaticOutstanding = false;
    const pending = current.latestBatch;
    current.latestBatch = undefined;
    if (pending && pending.generation > current.triggeredGeneration) enqueueBatch(pending);
  });
}

export { STRICT_POLICY, stripAssistantProse };
export type { FinalizeInput };
