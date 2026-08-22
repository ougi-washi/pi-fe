import { execFile } from "node:child_process";
import { mkdtemp, rename, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { sha256 } from "../src/policy.js";
import { RepositoryWatcher, type ChangeBatch, type WatchCommandRunner } from "../src/watcher.js";

const execFileAsync = promisify(execFile);
const runner: WatchCommandRunner = async (command, args, options) => {
  try {
    const result = await execFileAsync(command, args, { cwd: options.cwd, encoding: "utf8" });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string; code?: number };
    return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", code: typeof failure.code === "number" ? failure.code : 1 };
  }
};

async function repository(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "pi-fe-watch-"));
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await writeFile(resolve(root, ".gitignore"), "ignored.txt\nbuild/\n");
  await writeFile(resolve(root, "source.cpp"), "int value() { return 1; }\n");
  await execFileAsync("git", ["add", ".gitignore", "source.cpp"], { cwd: root });
  return root;
}

function nextBatch(batches: ChangeBatch[], timeoutMs = 2000): Promise<ChangeBatch> {
  return new Promise((resolvePromise, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (batches.length > 0) {
        clearInterval(timer);
        resolvePromise(batches.shift()!);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error("watch batch timeout"));
      }
    }, 10);
  });
}

async function waitReady(): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
}

describe("repository watcher", () => {
  it("coalesces rapid changes into one generation and hashes final content", async () => {
    const root = await repository();
    const batches: ChangeBatch[] = [];
    const watcher = await RepositoryWatcher.create({ root, debounceMs: 20, runner, onBatch: (batch) => { batches.push(batch); } });
    await watcher.start();
    await waitReady();
    await writeFile(resolve(root, "source.cpp"), "int value() { return 2; }\n");
    await writeFile(resolve(root, "source.cpp"), "int value() { return 3; }\n");
    const batch = await nextBatch(batches);
    expect(batch.generation).toBe(1);
    expect(batch.events).toEqual([{ kind: "change", path: "source.cpp", sha256: sha256("int value() { return 3; }\n") }]);
    await watcher.close();
  });

  it("ignores git-ignored files but watches untracked, unignored files", async () => {
    const root = await repository();
    const batches: ChangeBatch[] = [];
    const watcher = await RepositoryWatcher.create({ root, debounceMs: 20, runner, onBatch: (batch) => { batches.push(batch); } });
    await watcher.start();
    await waitReady();
    await writeFile(resolve(root, "ignored.txt"), "ignored\n");
    await writeFile(resolve(root, "contract.md"), "contract\n");
    const batch = await nextBatch(batches);
    expect(batch.events.map((event) => event.path)).toEqual(["contract.md"]);
    await watcher.close();
  });

  it("suppresses exactly the recorded committed hash and accepts a later unexpected hash", async () => {
    const root = await repository();
    const batches: ChangeBatch[] = [];
    const watcher = await RepositoryWatcher.create({ root, debounceMs: 20, runner, onBatch: (batch) => { batches.push(batch); } });
    await watcher.start();
    await waitReady();
    const committed = "int value() { return 4; }\n";
    watcher.recordCommitted("source.cpp", sha256(committed));
    await writeFile(resolve(root, "source.cpp"), committed);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
    expect(batches).toHaveLength(0);
    await writeFile(resolve(root, "source.cpp"), "int value() { return 5; }\n");
    expect((await nextBatch(batches)).events[0]?.sha256).toBe(sha256("int value() { return 5; }\n"));
    await watcher.close();
  });

  it("reports a pre-existing tracked-file rename from its cached content hash", async () => {
    const root = await repository();
    const batches: ChangeBatch[] = [];
    const watcher = await RepositoryWatcher.create({ root, debounceMs: 20, runner, onBatch: (batch) => { batches.push(batch); } });
    await watcher.start();
    await waitReady();
    await rename(resolve(root, "source.cpp"), resolve(root, "renamed.cpp"));
    expect((await nextBatch(batches)).events).toEqual([{
      kind: "rename",
      path: "renamed.cpp",
      previousPath: "source.cpp",
      sha256: sha256("int value() { return 1; }\n"),
    }]);
    await watcher.close();
  });

  it("pairs same-hash renames one-to-one without dropping another unlink", async () => {
    const root = await repository();
    await writeFile(resolve(root, "duplicate.cpp"), "int value() { return 1; }\n");
    await execFileAsync("git", ["add", "duplicate.cpp"], { cwd: root });
    const batches: ChangeBatch[] = [];
    const watcher = await RepositoryWatcher.create({ root, debounceMs: 20, runner, onBatch: (batch) => { batches.push(batch); } });
    await watcher.start();
    await waitReady();
    await Promise.all([
      rename(resolve(root, "source.cpp"), resolve(root, "renamed.cpp")),
      unlink(resolve(root, "duplicate.cpp")),
    ]);
    const events = (await nextBatch(batches)).events;
    expect(events.filter((event) => event.kind === "rename")).toHaveLength(1);
    expect(events.filter((event) => event.kind === "unlink")).toHaveLength(1);
    await watcher.close();
  });

  it("coalesces an atomic save at the same path and closes idempotently", async () => {
    const root = await repository();
    const batches: ChangeBatch[] = [];
    const watcher = await RepositoryWatcher.create({ root, debounceMs: 20, runner, onBatch: (batch) => { batches.push(batch); } });
    await watcher.start();
    await waitReady();
    const temporary = resolve(root, ".source.cpp.swap");
    await writeFile(temporary, "int value() { return 6; }\n");
    await rename(temporary, resolve(root, "source.cpp"));
    const events = (await nextBatch(batches)).events;
    expect(events).toHaveLength(1);
    expect(events[0]?.path).toBe("source.cpp");
    expect(events[0]?.kind).toBe("change");
    await watcher.close();
    await watcher.close();
  });
});
