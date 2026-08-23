import { lstat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";

export interface ProjectWatcherOptions {
  root: string;
  debounceMs?: number;
  onPaths: (paths: string[]) => void | Promise<void>;
  onError?: (error: unknown) => void;
  watcherFactory?: (root: string, options: Parameters<typeof chokidar.watch>[1]) => FSWatcher;
}

function normalizedRelative(root: string, path: string): string | undefined {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(root, path);
  const rel = relative(root, absolute);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return rel.split(sep).join("/");
}

function ignoredPath(root: string, path: string): boolean {
  const rel = normalizedRelative(root, path);
  if (!rel) return false;
  if (/(^|\/)(?:\.git|node_modules)(?:\/|$)/.test(rel)) return true;
  const name = basename(rel);
  return name.startsWith(".#") || name.endsWith("~") || /\.(?:sw[opx]?|tmp)$/i.test(name);
}

export class ProjectWatcher {
  private readonly root: string;
  private readonly debounceMs: number;
  private readonly options: ProjectWatcherOptions;
  private watcher: FSWatcher | undefined;
  private timer: NodeJS.Timeout | undefined;
  private readonly pending = new Set<string>();
  private closed = false;

  constructor(options: ProjectWatcherOptions) {
    this.options = options;
    this.root = resolve(options.root);
    this.debounceMs = options.debounceMs ?? 150;
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error("watcher_closed");
    if (this.watcher) return;

    const factory = this.options.watcherFactory ?? ((root, options) => chokidar.watch(root, options));
    const watcher = factory(this.root, {
      persistent: true,
      ignoreInitial: true,
      followSymlinks: false,
      atomic: false,
      awaitWriteFinish: {
        stabilityThreshold: Math.max(25, this.debounceMs),
        pollInterval: 20,
      },
      ignored: (path, stats) => Boolean(stats?.isSymbolicLink()) || ignoredPath(this.root, path),
    });
    this.watcher = watcher;

    watcher.on("all", (event, path) => {
      if (event !== "add" && event !== "change" && event !== "unlink") return;
      void this.receive(event, path);
    });
    watcher.on("error", (error) => this.options.onError?.(error));

    await new Promise<void>((resolveReady, rejectReady) => {
      const ready = (): void => {
        watcher.off("error", rejectReady);
        resolveReady();
      };
      watcher.once("ready", ready);
      watcher.once("error", rejectReady);
    });
  }

  private async receive(event: "add" | "change" | "unlink", path: string): Promise<void> {
    if (this.closed) return;
    const rel = normalizedRelative(this.root, path);
    if (!rel || ignoredPath(this.root, path)) return;
    if (event !== "unlink") {
      const info = await lstat(isAbsolute(path) ? path : resolve(this.root, path)).catch(() => undefined);
      if (!info || info.isSymbolicLink()) return;
    }
    if (this.closed) return;
    this.pending.add(rel);
    if (this.timer) clearTimeout(this.timer);
    const delay = event === "unlink" ? Math.max(100, this.debounceMs * 2) : this.debounceMs;
    this.timer = setTimeout(() => {
      void this.flush().catch((error) => this.options.onError?.(error));
    }, delay);
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.closed || this.pending.size === 0) return;
    const paths = [...this.pending].sort();
    this.pending.clear();
    await this.options.onPaths(paths);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending.clear();
    const watcher = this.watcher;
    this.watcher = undefined;
    await watcher?.close();
  }
}
