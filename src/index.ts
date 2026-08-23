import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  MessageEndEvent,
  ToolCallEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { ProjectWatcher } from "./watcher.js";

export const AUTOMATIC_PREFIX = "PI_FE_AUTOMATIC_IMPLEMENTATION";

const SNAPSHOT_FILE_LIMIT = 128 * 1024;
const SNAPSHOT_TOTAL_LIMIT = 512 * 1024;
const DIFF_LIMIT = 64 * 1024;
const DISCOVERY_TOOLS = ["grep", "find", "ls"];

export const IMPLEMENTATION_POLICY = `
PI-FE C/C++ IMPLEMENTATION MODE

The reported paths are the complete task boundary. For an initial batch, the reported project root requests one implementation-only scan. This is not a project review, TODO task, planning task, bug sweep, or verification run. Every reported file must be inspected from the CURRENT PASS SNAPSHOTS below or from a read completed during this pass. Ignore older file contents and tool results whenever a current snapshot is present. Do not settle after the first mismatch: inspect the complete changed file and every targeted direct dependency.

Current user-authored structs, classes, unions, enums, fields, bases, templates, typedefs, declarations, constants, and authoritative signatures are immutable inputs. Headers and other user-provided declarations are authoritative. Never edit them or alter user-owned type layout.

Treat every authoritative C/C++ declaration or type change as implementation work, including functions, methods, constructors, destructors, struct/class/union/enum shapes, renamed/added/removed/nested fields, bases, templates, typedefs, constants, and signatures. Reconcile every direct and unambiguous dependent use in existing C/C++ implementation files: bodies, out-of-line definitions, implementation-side signatures, member and array accesses, initializers, constructors, destructors, calls, and strictly necessary includes. For example, when authoritative declarations contain nested seb_files sources, update implementation references from module->sources_count to module->sources.count and from module->sources[...] to module->sources.paths[...] without modifying seb_files or seb_module.

You may only:
- fill or update matching implementation bodies and direct dependent implementation uses in existing C/C++ implementation files;
- add a missing out-of-line definition to an existing implementation file when it maps directly and unambiguously to an authoritative declaration;
- synchronize an implementation-side definition signature exactly to its authoritative declaration;
- add a strictly necessary implementation-file include.

Use grep, find, and ls only for targeted exact-identifier discovery across existing project files. Inspect only matching declarations, definitions, and uses. Do not inspect TODO files, choose project tasks, read Git history, perform broad project audits, or run shell commands, builds, tests, linters, formatters, benchmarks, compile databases, Clang analysis, or generated command lists. Do not create files, headers, tests, documentation, configuration, APIs, helper types, unrelated symbols, scaffolding, abstractions, fallbacks, speculative branches, logging, retries, placeholders, test-only behavior, compatibility workarounds, or unrelated cleanup.

Use the simplest, most direct, and most efficient implementation supported by the current code and declarations. Never invent semantics or implement a workaround. If implementation is genuinely impossible or presents a serious unresolved concern, add exactly one concise // @TODO: or // @NOTE: beside the relevant existing implementation location. If there is no existing implementation file, unambiguous location, or sufficient implementation contract, leave the declaration untouched.

Combine related replacements in one edit call. After any successful edit, reread that file before another edit. Use tools without explanatory prose.
`.trim();

type AssistantMessage = Extract<MessageEndEvent["message"], { role: "assistant" }>;

interface AutomaticBatch {
  kind: "initial" | "changes";
  paths: string[];
}

interface Snapshot {
  path: string;
  status: "current" | "deleted" | "read-required";
  reason?: string;
  bytes?: Buffer;
  text?: string;
}

interface StartedRead {
  path: string;
  bytes: Buffer;
}

interface RuntimeState {
  watcher: ProjectWatcher | undefined;
  root: string | undefined;
  rootReal: string | undefined;
  pendingPaths: Set<string>;
  initialPending: boolean;
  agentRunning: boolean;
  automaticOutstanding: boolean;
  automaticRun: boolean;
  snapshots: Map<string, Buffer>;
  snapshotContext: string;
  stableReads: Map<string, Buffer>;
  startedReads: Map<string, StartedRead>;
  editCalls: Map<string, string>;
  editReservations: Map<string, string>;
  toolsBeforeAutomatic: string[] | undefined;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function normalizedPath(root: string, path: string, allowRoot = false): string | undefined {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(root, path);
  if (!inside(root, absolute)) return undefined;
  const rel = relative(root, absolute);
  if (!rel) return allowRoot ? "." : undefined;
  return rel.split(sep).join("/");
}

function reportedPaths(root: string, paths: unknown): string[] {
  if (!Array.isArray(paths)) return [];
  const normalized = paths
    .filter((path): path is string => typeof path === "string")
    .map((path) => normalizedPath(root, path, true))
    .filter((path): path is string => path !== undefined);
  return [...new Set(normalized)].sort();
}

async function regularTarget(
  root: string,
  rootReal: string,
  path: string,
): Promise<{ absolute: string; path: string } | undefined> {
  const normalized = normalizedPath(root, path);
  if (!normalized) return undefined;
  const absolute = resolve(root, normalized);
  const info = await lstat(absolute).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink()) return undefined;
  const actual = await realpath(absolute).catch(() => undefined);
  const expected = resolve(rootReal, normalized);
  if (!actual || actual !== expected || !inside(rootReal, actual)) return undefined;
  return { absolute, path: normalized };
}

function equalBytes(left: Buffer | undefined, right: Buffer | undefined): boolean {
  return left !== undefined && right !== undefined && left.equals(right);
}

async function captureSnapshots(root: string, rootReal: string, paths: string[]): Promise<Snapshot[]> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const snapshots: Snapshot[] = [];
  let injectedBytes = 0;

  for (const path of paths) {
    if (path === ".") {
      snapshots.push({ path, status: "read-required", reason: "project root; discover and read existing files" });
      continue;
    }

    const absolute = resolve(root, path);
    const info = await lstat(absolute).catch(() => undefined);
    if (!info) {
      snapshots.push({ path, status: "deleted" });
      continue;
    }
    if (info.isSymbolicLink()) {
      snapshots.push({ path, status: "read-required", reason: "symbolic link; automatic edits are prohibited" });
      continue;
    }
    if (!info.isFile()) {
      snapshots.push({ path, status: "read-required", reason: "not a regular file" });
      continue;
    }

    const actual = await realpath(absolute).catch(() => undefined);
    if (!actual || actual !== resolve(rootReal, path) || !inside(rootReal, actual)) {
      snapshots.push({ path, status: "read-required", reason: "path does not resolve directly inside the project" });
      continue;
    }
    if (info.size > SNAPSHOT_FILE_LIMIT) {
      snapshots.push({ path, status: "read-required", reason: `larger than ${SNAPSHOT_FILE_LIMIT} bytes` });
      continue;
    }

    const bytes = await readFile(absolute).catch(() => undefined);
    if (!bytes) {
      snapshots.push({ path, status: "read-required", reason: "could not capture current bytes" });
      continue;
    }
    const verified = await regularTarget(root, rootReal, path);
    const verifiedBytes = verified ? await readFile(verified.absolute).catch(() => undefined) : undefined;
    if (!verified || bytes.length > SNAPSHOT_FILE_LIMIT || !equalBytes(bytes, verifiedBytes)) {
      snapshots.push({ path, status: "read-required", reason: "file changed while its snapshot was captured" });
      continue;
    }
    let text: string;
    try {
      if (bytes.includes(0)) throw new Error("binary");
      text = decoder.decode(bytes);
    } catch {
      snapshots.push({ path, status: "read-required", reason: "non-text content" });
      continue;
    }
    if (injectedBytes + bytes.length > SNAPSHOT_TOTAL_LIMIT) {
      snapshots.push({ path, status: "read-required", reason: `snapshot total exceeds ${SNAPSHOT_TOTAL_LIMIT} bytes` });
      continue;
    }
    injectedBytes += bytes.length;
    snapshots.push({ path, status: "current", bytes, text });
  }

  return snapshots;
}

function renderSnapshots(snapshots: Snapshot[], diff: string): string {
  const sections = ["PI-FE CURRENT PASS SNAPSHOTS", "These current-pass snapshots are authoritative over older context and the Git diff."];
  for (const snapshot of snapshots) {
    const name = JSON.stringify(snapshot.path);
    if (snapshot.status === "deleted") {
      sections.push(`FILE ${name}: deleted`);
    } else if (snapshot.status === "read-required") {
      sections.push(`FILE ${name}: read-required (${snapshot.reason})`);
    } else {
      sections.push(`FILE ${name}: current UTF-8 snapshot (${snapshot.bytes!.length} bytes)\n${snapshot.text}\nEND FILE ${name}`);
    }
  }
  if (diff) sections.push(`CURRENT ZERO-CONTEXT GIT DIFF (snapshot wins on disagreement)\n${diff}`);
  return sections.join("\n\n");
}

function truncateUtf8(value: string, limit: number): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= limit) return value.trim();
  return `${bytes.subarray(0, limit).toString("utf8")}\n[diff truncated at ${limit} bytes]`.trim();
}

async function currentDiff(pi: ExtensionAPI, root: string, paths: string[]): Promise<string> {
  if (paths.length === 0) return "";
  const result = await pi.exec("git", ["diff", "--no-ext-diff", "--unified=0", "HEAD", "--", ...paths], {
    cwd: root,
    timeout: 5000,
  }).catch(() => undefined);
  return result?.code === 0 ? truncateUtf8(result.stdout, DIFF_LIMIT) : "";
}

function automaticContent(batch: AutomaticBatch): string {
  return `${AUTOMATIC_PREFIX}\nkind=${batch.kind}\npaths:\n${batch.paths.join("\n")}`;
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
    root: undefined,
    rootReal: undefined,
    pendingPaths: new Set<string>(),
    initialPending: false,
    agentRunning: false,
    automaticOutstanding: false,
    automaticRun: false,
    snapshots: new Map<string, Buffer>(),
    snapshotContext: "",
    stableReads: new Map<string, Buffer>(),
    startedReads: new Map<string, StartedRead>(),
    editCalls: new Map<string, string>(),
    editReservations: new Map<string, string>(),
    toolsBeforeAutomatic: undefined,
  };

  const clearFreshness = (): void => {
    state.snapshots.clear();
    state.snapshotContext = "";
    state.stableReads.clear();
    state.startedReads.clear();
    state.editCalls.clear();
    state.editReservations.clear();
  };

  const restoreTools = (): void => {
    if (state.toolsBeforeAutomatic === undefined) return;
    const tools = state.toolsBeforeAutomatic;
    state.toolsBeforeAutomatic = undefined;
    pi.setActiveTools(tools);
  };

  const clearAutomaticRun = (): void => {
    try {
      restoreTools();
    } finally {
      clearFreshness();
      state.automaticRun = false;
    }
  };

  const enableAutomaticTools = (): void => {
    if (state.toolsBeforeAutomatic !== undefined) return;
    const active = pi.getActiveTools();
    const registered = new Set(pi.getAllTools().map((tool) => tool.name));
    state.toolsBeforeAutomatic = [...active];
    const next = active.filter((tool) => tool !== "bash" && tool !== "write");
    for (const tool of DISCOVERY_TOOLS) {
      if (registered.has(tool) && !next.includes(tool)) next.push(tool);
    }
    pi.setActiveTools(next);
  };

  const sendAutomatic = (batch: AutomaticBatch): boolean => {
    if (!state.watcher || state.agentRunning || state.automaticOutstanding) return false;
    try {
      enableAutomaticTools();
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
    } catch (error) {
      state.automaticOutstanding = false;
      clearAutomaticRun();
      throw error;
    }
    return true;
  };

  const sendPending = (): void => {
    if (!state.watcher || state.agentRunning || state.automaticOutstanding) return;
    if (state.initialPending) {
      if (sendAutomatic({ kind: "initial", paths: ["."] })) state.initialPending = false;
      return;
    }
    if (state.pendingPaths.size === 0) return;
    const paths = [...state.pendingPaths].sort();
    if (sendAutomatic({ kind: "changes", paths })) {
      for (const path of paths) state.pendingPaths.delete(path);
    }
  };

  const stop = async (ctx?: Pick<ExtensionCommandContext, "ui">, announce = false): Promise<void> => {
    const watcher = state.watcher;
    state.watcher = undefined;
    state.root = undefined;
    state.rootReal = undefined;
    state.pendingPaths.clear();
    state.initialPending = false;
    state.automaticOutstanding = false;
    clearAutomaticRun();
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

      state.root = resolve(ctx.cwd);
      state.rootReal = await realpath(state.root);
      const watcher = new ProjectWatcher({
        root: state.root,
        onPaths: (paths) => {
          for (const path of paths) state.pendingPaths.add(path);
          sendPending();
        },
        onError: () => {
          ctx.ui.notify("pi-fe:watch-error", "error");
          void stop(ctx);
        },
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
      state.initialPending = true;
      sendPending();
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    await stop(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await stop(ctx);
  });

  pi.on("message_start", async (event) => {
    if (event.message.role === "user" && (state.automaticRun || state.toolsBeforeAutomatic !== undefined)) {
      clearAutomaticRun();
      return;
    }
    if (event.message.role !== "custom" || event.message.customType !== "pi-fe-implementation") return;
    if (!state.watcher || !state.root || !state.rootReal) return;

    clearFreshness();
    state.automaticRun = true;
    let paths: string[] = [];
    try {
      enableAutomaticTools();
      const details = event.message.details as { paths?: unknown } | undefined;
      paths = reportedPaths(state.root, details?.paths);
      const snapshots = await captureSnapshots(state.root, state.rootReal, paths);
      for (const snapshot of snapshots) {
        if (snapshot.status === "current") state.snapshots.set(snapshot.path, snapshot.bytes!);
      }
      const diff = await currentDiff(pi, state.root, paths);
      state.snapshotContext = renderSnapshots(snapshots, diff);
    } catch (error) {
      clearAutomaticRun();
      state.automaticOutstanding = false;
      for (const path of paths) {
        if (path !== ".") state.pendingPaths.add(path);
      }
      throw error;
    }
  });

  pi.on("context", (event) => {
    if (!state.automaticRun) return;
    const index = event.messages.findLastIndex(
      (message) => message.role === "custom" && message.customType === "pi-fe-implementation",
    );
    if (index < 0) return;
    const message = event.messages[index]!;
    if (message.role !== "custom") return;
    const messages = [...event.messages];
    messages[index] = { ...message, content: `${IMPLEMENTATION_POLICY}\n\n${message.content}\n\n${state.snapshotContext}` };
    return { messages };
  });

  pi.on("message_end", (event) => {
    if (!state.automaticRun || event.message.role !== "assistant") return;
    return { message: stripAutomaticProse(event.message) };
  });

  pi.on("tool_call", async (event: ToolCallEvent) => {
    if (!state.automaticRun || !state.root || !state.rootReal) return;
    if (event.toolName === "bash" || event.toolName === "write") {
      return { block: true, reason: `pi-fe automatic turns do not run ${event.toolName}` };
    }

    if (isToolCallEventType("read", event)) {
      const target = await regularTarget(state.root, state.rootReal, event.input.path);
      if (!target) return;
      const bytes = await readFile(target.absolute).catch(() => undefined);
      if (bytes) state.startedReads.set(event.toolCallId, { path: target.path, bytes });
      return;
    }

    if (!isToolCallEventType("edit", event)) return;
    const target = await regularTarget(state.root, state.rootReal, event.input.path);
    if (!target) {
      return { block: true, reason: "pi-fe: edit target must be an existing non-symlink regular file inside the project" };
    }
    if (state.editReservations.has(target.path)) {
      return { block: true, reason: "pi-fe: edit target is already reserved by another automatic edit" };
    }

    state.editReservations.set(target.path, event.toolCallId);
    const current = await readFile(target.absolute).catch(() => undefined);
    const snapshot = state.snapshots.get(target.path);
    const stableRead = state.stableReads.get(target.path);
    if (!equalBytes(current, snapshot) && !equalBytes(current, stableRead)) {
      state.editReservations.delete(target.path);
      state.pendingPaths.add(target.path);
      return {
        block: true,
        reason: "pi-fe: stale edit rejected; the file changed or was not read in this automatic pass. Read the current file and retry",
      };
    }
    const currentText = current?.toString("utf8");
    if (!currentText || event.input.edits.some((edit) => !edit.oldText || !currentText.includes(edit.oldText))) {
      state.editReservations.delete(target.path);
      state.pendingPaths.add(target.path);
      return {
        block: true,
        reason: "pi-fe: stale edit rejected; replacement text is not present in the current file. Read the current file and retry",
      };
    }
    state.editCalls.set(event.toolCallId, target.path);
  });

  pi.on("tool_result", async (event: ToolResultEvent) => {
    if (!state.automaticRun || !state.root || !state.rootReal) return;
    if (event.toolName === "read") {
      const started = state.startedReads.get(event.toolCallId);
      state.startedReads.delete(event.toolCallId);
      if (!started) return;
      const target = await regularTarget(state.root, state.rootReal, started.path);
      const current = target ? await readFile(target.absolute).catch(() => undefined) : undefined;
      if (!equalBytes(current, started.bytes)) {
        state.stableReads.delete(started.path);
        state.pendingPaths.add(started.path);
        return {
          content: [{ type: "text", text: "pi-fe: stale read rejected; the file changed during the read. Read it again" }],
          isError: true,
        };
      }
      if (!event.isError) state.stableReads.set(started.path, started.bytes);
      return;
    }

    if (event.toolName !== "edit") return;
    const path = state.editCalls.get(event.toolCallId);
    state.editCalls.delete(event.toolCallId);
    if (!path) return;
    if (state.editReservations.get(path) === event.toolCallId) state.editReservations.delete(path);
    if (!event.isError) {
      state.snapshots.delete(path);
      state.stableReads.delete(path);
    }
  });

  pi.registerMarkdownTransformer((markdown, context) => {
    if (state.automaticRun && (context.messageType === "assistant" || context.messageType === "assistant-thinking")) return "";
    return markdown;
  });

  pi.on("agent_start", () => {
    state.agentRunning = true;
  });

  pi.on("agent_end", () => {
    if (state.automaticRun) clearAutomaticRun();
  });

  pi.on("agent_settled", () => {
    state.agentRunning = false;
    if (state.automaticOutstanding) {
      clearAutomaticRun();
      state.automaticOutstanding = false;
    }
    sendPending();
  });
}
