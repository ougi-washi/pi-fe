import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, matchesGlob, relative, resolve, sep } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { isContained, normalizeRelativePath, sha256 } from "./policy.js";

export type ChangeKind = "add" | "change" | "unlink" | "rename";

export interface ChangeEvent {
  kind: ChangeKind;
  path: string;
  sha256: string;
  previousPath?: string;
}

export interface ChangeBatch {
  type: "cxx_change";
  generation: number;
  events: ChangeEvent[];
}

export interface WatchCommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type WatchCommandRunner = (command: string, args: string[], options: { cwd: string }) => Promise<WatchCommandResult>;

export interface RepositoryWatcherOptions {
  root: string;
  debounceMs: number;
  include?: string[];
  exclude?: string[];
  runner: WatchCommandRunner;
  onBatch: (batch: ChangeBatch) => void | Promise<void>;
  watcherFactory?: (root: string, options: Parameters<typeof chokidar.watch>[1]) => FSWatcher;
}

interface PendingEvent extends ChangeEvent {
  sequence: number;
}

export async function discoverRepositoryRoot(cwd: string, runner: WatchCommandRunner): Promise<{ root: string; git: boolean }> {
  const result = await runner("git", ["rev-parse", "--show-toplevel"], { cwd });
  if (result.code === 0 && result.stdout.trim()) return { root: await realpath(result.stdout.trim()), git: true };
  return { root: await realpath(cwd), git: false };
}

function globMatch(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    try {
      return matchesGlob(path, pattern);
    } catch {
      return false;
    }
  });
}

function lexicalRelative(root: string, path: string): string | undefined {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(root, path);
  if (!isContained(root, absolute)) return undefined;
  const rel = relative(root, absolute);
  return rel === "" ? undefined : normalizeRelativePath(rel);
}

export class RepositoryWatcher {
  readonly root: string;
  readonly git: boolean;
  private readonly options: RepositoryWatcherOptions;
  private watcher: FSWatcher | undefined;
  private timer: NodeJS.Timeout | undefined;
  private sequence = 0;
  private generation = 0;
  private pending: PendingEvent[] = [];
  private readonly knownHashes = new Map<string, string>();
  private readonly suppressions = new Map<string, string>();
  private readonly tracked = new Set<string>();
  private closed = false;

  private constructor(options: RepositoryWatcherOptions, root: string, git: boolean) {
    this.options = options;
    this.root = root;
    this.git = git;
  }

  static async create(options: RepositoryWatcherOptions): Promise<RepositoryWatcher> {
    const discovered = await discoverRepositoryRoot(options.root, options.runner);
    const instance = new RepositoryWatcher(options, discovered.root, discovered.git);
    if (discovered.git) await instance.loadTrackedFiles();
    return instance;
  }

  private async loadTrackedFiles(): Promise<void> {
    const result = await this.options.runner("git", ["ls-files", "-z", "--cached"], { cwd: this.root });
    if (result.code !== 0) throw new Error(`git_ls_files_failed:${result.stderr.trim()}`);
    for (const path of result.stdout.split("\0")) {
      if (!path) continue;
      const rel = normalizeRelativePath(path);
      this.tracked.add(rel);
      try {
        const absolute = resolve(this.root, rel);
        const canonical = await realpath(absolute);
        if (canonical === absolute) this.knownHashes.set(rel, sha256(await readFile(canonical)));
      } catch {
        // A tracked path may be absent in the working tree; its first event remains external.
      }
    }
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error("watcher_closed");
    if (this.watcher) return;
    const factory = this.options.watcherFactory ?? ((root, options) => chokidar.watch(root, options));
    this.watcher = factory(this.root, {
      persistent: true,
      ignoreInitial: true,
      followSymlinks: false,
      atomic: false,
      awaitWriteFinish: { stabilityThreshold: Math.max(25, this.options.debounceMs), pollInterval: 20 },
      ignored: (path, stats) => {
        const rel = lexicalRelative(this.root, path);
        if (!rel) return false;
        if (rel === ".git" || rel.startsWith(".git/")) return true;
        if (stats?.isDirectory() && ["node_modules", "build", "out", "dist", "vendor", "generated", ".cache"].includes(rel.split("/").at(-1) ?? "")) return true;
        return false;
      },
    });
    this.watcher.on("add", (path) => { void this.receive("add", path).catch((error) => this.failClosed(error)); });
    this.watcher.on("change", (path) => { void this.receive("change", path).catch((error) => this.failClosed(error)); });
    this.watcher.on("unlink", (path) => { void this.receive("unlink", path).catch((error) => this.failClosed(error)); });
    this.watcher.on("error", (error) => { void this.failClosed(error); });
  }

  recordCommitted(path: string, hash: string): void {
    const rel = lexicalRelative(this.root, path);
    if (!rel) throw new Error("suppression_path_outside_repository");
    this.suppressions.set(rel, hash);
    this.knownHashes.set(rel, hash);
  }

  currentGeneration(): number {
    return this.generation;
  }

  private async included(rel: string): Promise<boolean> {
    const excludes = this.options.exclude ?? [];
    if (globMatch(rel, excludes)) return false;
    if (!this.git) return globMatch(rel, this.options.include ?? ["**/*"]);
    if (this.tracked.has(rel)) return true;
    const result = await this.options.runner("git", ["check-ignore", "-q", "--", rel], { cwd: this.root });
    if (result.code === 1) return true;
    if (result.code === 0) return false;
    throw new Error(`git_check_ignore_failed:${rel}:${result.stderr.trim()}`);
  }

  private async receive(kind: Exclude<ChangeKind, "rename">, path: string): Promise<void> {
    if (this.closed) return;
    const rel = lexicalRelative(this.root, path);
    if (!rel || !(await this.included(rel)) || this.closed) return;

    let hash = "";
    if (kind === "unlink") {
      hash = this.knownHashes.get(rel) ?? sha256("");
      this.knownHashes.delete(rel);
    } else {
      const canonical = await realpath(resolve(this.root, rel));
      if (!isContained(this.root, canonical) || canonical !== resolve(this.root, rel)) return;
      hash = sha256(await readFile(canonical));
      const suppressedHash = this.suppressions.get(rel);
      if (suppressedHash === hash) {
        this.suppressions.delete(rel);
        this.knownHashes.set(rel, hash);
        return;
      }
      if (suppressedHash !== undefined) this.suppressions.delete(rel);
      this.knownHashes.set(rel, hash);
    }
    if (this.closed) return;

    this.pending.push({ kind, path: rel, sha256: hash, sequence: ++this.sequence });
    if (this.timer) clearTimeout(this.timer);
    const delay = kind === "unlink" ? Math.max(100, this.options.debounceMs * 2) : this.options.debounceMs;
    this.timer = setTimeout(() => { void this.flush(); }, delay);
  }

  private normalize(events: PendingEvent[]): ChangeEvent[] {
    const byPath = new Map<string, PendingEvent[]>();
    for (const event of events) {
      const list = byPath.get(event.path) ?? [];
      list.push(event);
      byPath.set(event.path, list);
    }
    const reduced: PendingEvent[] = [];
    for (const list of byPath.values()) {
      list.sort((a, b) => a.sequence - b.sequence);
      const first = list[0];
      const last = list.at(-1);
      if (!first || !last) continue;
      if (list.some((event) => event.kind === "unlink") && last.kind !== "unlink") {
        reduced.push({ ...last, kind: first.kind === "add" ? "add" : "change" });
      } else {
        reduced.push(last);
      }
    }

    const removedByHash = new Map<string, PendingEvent[]>();
    for (const event of reduced) {
      if (event.kind !== "unlink") continue;
      const values = removedByHash.get(event.sha256) ?? [];
      values.push(event);
      removedByHash.set(event.sha256, values);
    }
    const consumed = new Set<PendingEvent>();
    const renameByAdd = new Map<PendingEvent, PendingEvent>();
    for (const added of reduced.filter((event) => event.kind === "add").sort((a, b) => a.sequence - b.sequence)) {
      const removed = removedByHash.get(added.sha256)?.find((candidate) => !consumed.has(candidate) && candidate.path !== added.path);
      if (removed) {
        consumed.add(removed);
        renameByAdd.set(added, removed);
      }
    }
    const output: ChangeEvent[] = [];
    for (const event of reduced.sort((a, b) => a.sequence - b.sequence)) {
      if (consumed.has(event)) continue;
      const removed = renameByAdd.get(event);
      if (removed) {
        output.push({ kind: "rename", path: event.path, previousPath: removed.path, sha256: event.sha256 });
        continue;
      }
      output.push({ kind: event.kind, path: event.path, sha256: event.sha256 });
    }
    return output.sort((a, b) => a.path.localeCompare(b.path));
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.pending.length === 0 || this.closed) return;
    const events = this.normalize(this.pending.splice(0));
    if (events.length === 0) return;
    await this.options.onBatch({ type: "cxx_change", generation: ++this.generation, events });
  }

  private async failClosed(error: unknown): Promise<void> {
    if (this.closed) return;
    const digest = createHash("sha256").update(String(error)).digest("hex");
    this.pending.push({ kind: "change", path: ".", sha256: digest, sequence: ++this.sequence });
    await this.flush();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = [];
    const watcher = this.watcher;
    this.watcher = undefined;
    await watcher?.close();
  }
}
