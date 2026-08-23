import { mkdir, mkdtemp, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectWatcher } from "../src/watcher.js";

async function workspace(): Promise<string> {
  return mkdtemp(resolve(tmpdir(), "pi-fe-watch-"));
}

function nextBatch(batches: string[][], timeoutMs = 2500): Promise<string[]> {
  return new Promise((resolveBatch, rejectBatch) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const batch = batches.shift();
      if (batch) {
        clearInterval(timer);
        resolveBatch(batch);
      } else if (Date.now() - started >= timeoutMs) {
        clearInterval(timer);
        rejectBatch(new Error("watch batch timeout"));
      }
    }, 10);
  });
}

describe("project watcher", () => {
  it("coalesces changes for every language into normalized relative paths", async () => {
    const root = await workspace();
    const batches: string[][] = [];
    const watcher = new ProjectWatcher({ root, debounceMs: 25, onPaths: (paths) => { batches.push(paths); } });
    await watcher.start();

    await Promise.all([
      writeFile(resolve(root, "contract.hpp"), "struct Value {};\n"),
      writeFile(resolve(root, "implementation.cpp"), "int value() { return 1; }\n"),
      writeFile(resolve(root, "README.md"), "contract\n"),
      writeFile(resolve(root, "module.py"), "value = 1\n"),
    ]);

    expect(await nextBatch(batches)).toEqual([
      "README.md",
      "contract.hpp",
      "implementation.cpp",
      "module.py",
    ]);
    await watcher.close();
  });

  it("ignores repository metadata, dependencies, editor temporaries, and symlinked trees", async () => {
    const root = await workspace();
    const outside = await workspace();
    await mkdir(resolve(root, ".git"));
    await mkdir(resolve(root, "node_modules"));
    await writeFile(resolve(outside, "external.cpp"), "int value();\n");
    await symlink(outside, resolve(root, "linked"), "dir");

    const batches: string[][] = [];
    const watcher = new ProjectWatcher({ root, debounceMs: 25, onPaths: (paths) => { batches.push(paths); } });
    await watcher.start();

    await Promise.all([
      writeFile(resolve(root, ".git", "index"), "metadata"),
      writeFile(resolve(root, "node_modules", "dependency.js"), "dependency"),
      writeFile(resolve(root, ".#source.cpp"), "temporary"),
      writeFile(resolve(root, "source.cpp.swp"), "temporary"),
      writeFile(resolve(root, "source.cpp~"), "temporary"),
      writeFile(resolve(outside, "external.cpp"), "int value() { return 1; }\n"),
    ]);

    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    expect(batches).toEqual([]);
    await watcher.close();
  });

  it("reports both paths of a rename as one implementation-rescan batch", async () => {
    const root = await workspace();
    await writeFile(resolve(root, "old.cpp"), "int value();\n");
    const batches: string[][] = [];
    const watcher = new ProjectWatcher({ root, debounceMs: 25, onPaths: (paths) => { batches.push(paths); } });
    await watcher.start();

    await rename(resolve(root, "old.cpp"), resolve(root, "new.cpp"));
    expect(await nextBatch(batches)).toEqual(["new.cpp", "old.cpp"]);
    await watcher.close();
  });

  it("closes idempotently and discards pending paths", async () => {
    const root = await workspace();
    const batches: string[][] = [];
    const watcher = new ProjectWatcher({ root, debounceMs: 100, onPaths: (paths) => { batches.push(paths); } });
    await watcher.start();
    await writeFile(resolve(root, "source.c"), "int value(void);\n");
    await watcher.close();
    await watcher.close();
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
    expect(batches).toEqual([]);
  });
});
