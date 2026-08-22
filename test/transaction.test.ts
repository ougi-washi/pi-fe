import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { AstAnalysis, CommandRunner, ContractResult } from "../src/clang.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { hashHeaders, sha256 } from "../src/policy.js";
import { TransactionEngine } from "../src/transaction.js";

const noMetrics = {
  symbol: "value", allocation: 0, containerGrowth: 0, stringConstruction: 0, nonTrivialCopy: 0,
  lock: 0, atomic: 0, exception: 0, rtti: 0, virtualDispatch: 0, loop: 0, branch: 0, systemCall: 0, logging: 0,
};

async function project(twoFiles = false) {
  const root = await mkdtemp(resolve(tmpdir(), "pi-fe-transaction-"));
  await mkdir(resolve(root, "src"));
  await mkdir(resolve(root, "include"));
  const header = "// contract: test_fixture_expected_return\nint value(void);\n";
  const source = "int value(void) {\n  return 1;\n}\n";
  await writeFile(resolve(root, "include", "value.h"), header);
  await writeFile(resolve(root, "src", "value.c"), source);
  if (twoFiles) await writeFile(resolve(root, "src", "other.c"), "int other(void) {\n  return 1;\n}\n");
  return { root, header, source };
}

function ast(path: string, content: string): AstAnalysis {
  const open = content.indexOf("{");
  const close = content.lastIndexOf("}") + 1;
  const hasBody = open >= 0 && close > open;
  const declaration = {
    id: "value", kind: "FunctionDecl", name: "value", qualifiedName: "value", signature: "int (void)",
    mangledName: "value", path, line: 1, external: true, definition: hasBody,
  };
  const headerDeclaration = { ...declaration, id: "header-value", path: "include/value.h", line: 2, definition: false };
  return {
    declarations: [headerDeclaration, declaration], definitions: hasBody ? [declaration] : [],
    bodyRanges: hasBody ? [{ path, start: open, end: close, symbol: "value", symbolKey: "value" }] : [], references: [],
    forbiddenSurface: content.includes("struct Added") ? ["CXXRecordDecl:Added:different"] : [],
    exportedSymbols: ["value"], metrics: hasBody ? [{ ...noMetrics }] : [], headerPaths: ["include/value.h"], diagnostics: [],
  };
}

function fakeClang(root: string) {
  return {
    async contract(path: string): Promise<ContractResult> {
      const content = await readFile(resolve(root, path), "utf8");
      return {
        ...ast(path, content),
        compileCommand: {
          databasePath: resolve(root, "compile_commands.json"), directory: root, file: resolve(root, path),
          executable: "clang", arguments: [resolve(root, path)], hash: "command",
        },
        headerRootHash: await hashHeaders(root),
      };
    },
    async analyzeCandidate(_command: unknown, path: string): Promise<AstAnalysis> {
      return ast("src/value.c", await readFile(path, "utf8"));
    },
    clearCache() {},
  };
}

const runner: CommandRunner = async () => ({ stdout: "", stderr: "", code: 0 });

async function evidence(root: string) {
  const path = resolve(root, "include", "value.h");
  const hash = sha256(await readFile(path));
  return [
    { kind: "header_decl", path: "include/value.h", line: 2, sha256: hash, symbol: "value" },
    { kind: "header_contract", path: "include/value.h", line: 1, sha256: hash, symbol: "value", constraint: "test_fixture_expected_return" },
  ];
}

function engine(root: string, generation: () => number, queueMutation = async <T>(_path: string, operation: () => Promise<T>) => operation()) {
  return new TransactionEngine({
    root,
    config: structuredClone(DEFAULT_CONFIG),
    clang: fakeClang(root) as never,
    runner,
    getGeneration: generation,
    queueMutation,
  });
}

describe("transaction engine", () => {
  it("commits a verified body-only replacement", async () => {
    const { root, source } = await project();
    const transaction = engine(root, () => 7);
    const result = await transaction.apply({
      generation: 7,
      headerRootHash: await hashHeaders(root),
      changes: [{ path: "src/value.c", expectedSha256: sha256(source), edits: [{ oldText: "return 1;", newText: "return 2;" }] }],
      evidence: await evidence(root),
    });
    expect(result.status).toBe("changed");
    expect(await readFile(resolve(root, "src", "value.c"), "utf8")).toContain("return 2;");
  });

  it("rejects stale generations and source hashes without mutation", async () => {
    const { root, source } = await project();
    const transaction = engine(root, () => 2);
    const staleGeneration = await transaction.apply({
      generation: 1, headerRootHash: await hashHeaders(root),
      changes: [{ path: "src/value.c", expectedSha256: sha256(source), edits: [{ oldText: "return 1;", newText: "return 2;" }] }],
      evidence: await evidence(root),
    });
    expect(staleGeneration.diagnostics).toContain("stale_input");
    const staleHash = await transaction.apply({
      generation: 2, headerRootHash: await hashHeaders(root),
      changes: [{ path: "src/value.c", expectedSha256: "0".repeat(64), edits: [{ oldText: "return 1;", newText: "return 2;" }] }],
      evidence: await evidence(root),
    });
    expect(staleHash.diagnostics).toContain("stale_source");
    expect(await readFile(resolve(root, "src", "value.c"), "utf8")).toBe(source);
  });

  it("requires symbol-tied behavioral evidence instead of treating a bare declaration as behavior", async () => {
    const { root, source } = await project();
    const transaction = engine(root, () => 1);
    const headerPath = resolve(root, "include", "value.h");
    const result = await transaction.apply({
      generation: 1, headerRootHash: await hashHeaders(root),
      changes: [{ path: "src/value.c", expectedSha256: sha256(source), edits: [{ oldText: "return 1;", newText: "return 2;" }] }],
      evidence: [{ kind: "header_decl", path: "include/value.h", line: 2, sha256: sha256(await readFile(headerPath)), symbol: "value" }],
    });
    expect(result.diagnostics).toContain("behavioral_evidence_required:value");
    expect(await readFile(resolve(root, "src", "value.c"), "utf8")).toBe(source);
  });

  it("rejects definition removal and changed preprocessor directives inside bodies", async () => {
    const { root, source } = await project();
    const transaction = engine(root, () => 1);
    const removed = await transaction.apply({
      generation: 1, headerRootHash: await hashHeaders(root),
      changes: [{ path: "src/value.c", expectedSha256: sha256(source), edits: [{ oldText: "{\n  return 1;\n}", newText: ";" }] }],
      evidence: await evidence(root),
    });
    expect(removed.status).toBe("rejected");
    const macro = await transaction.apply({
      generation: 1, headerRootHash: await hashHeaders(root),
      changes: [{ path: "src/value.c", expectedSha256: sha256(source), edits: [{ oldText: "  return 1;", newText: "#define VALUE 2\n  return VALUE;" }] }],
      evidence: await evidence(root),
    });
    expect(macro.diagnostics).toContain("preprocessor_edit_denied");
    expect(await readFile(resolve(root, "src", "value.c"), "utf8")).toBe(source);
  });

  it("rejects structural changes and edits outside function bodies", async () => {
    const { root, source } = await project();
    const transaction = engine(root, () => 1);
    const result = await transaction.apply({
      generation: 1, headerRootHash: await hashHeaders(root),
      changes: [{ path: "src/value.c", expectedSha256: sha256(source), edits: [{ oldText: "int value(void)", newText: "struct Added {};\nint value(void)" }] }],
      evidence: await evidence(root),
    });
    expect(result.status).toBe("rejected");
    expect(await readFile(resolve(root, "src", "value.c"), "utf8")).toBe(source);
  });

  it("rejects a concurrent external edit before any multi-file commit", async () => {
    const { root, source } = await project(true);
    const otherPath = resolve(root, "src", "other.c");
    const other = await readFile(otherPath, "utf8");
    let raced = false;
    const queue = async <T>(path: string, operation: () => Promise<T>): Promise<T> => {
      if (!raced && path.endsWith("other.c")) {
        raced = true;
        await writeFile(otherPath, "int other(void) { return 9; }\n");
      }
      return operation();
    };
    const transaction = engine(root, () => 3, queue);
    const result = await transaction.apply({
      generation: 3, headerRootHash: await hashHeaders(root),
      changes: [
        { path: "src/value.c", expectedSha256: sha256(source), edits: [{ oldText: "return 1;", newText: "return 2;" }] },
        { path: "src/other.c", expectedSha256: sha256(other), edits: [{ oldText: "return 1;", newText: "return 2;" }] },
      ],
      evidence: await evidence(root),
    });
    expect(result.status).toBe("rejected");
    expect(await readFile(resolve(root, "src", "value.c"), "utf8")).toBe(source);
  });

  it("rejects a configured hot-path benchmark regression", async () => {
    const { root, source } = await project();
    let invocation = 0;
    const timedRunner: CommandRunner = async () => {
      invocation++;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, invocation % 2 === 1 ? 1 : 12));
      return { stdout: "", stderr: "", code: 0 };
    };
    const config = structuredClone(DEFAULT_CONFIG);
    config.performance.hotSymbols = ["value"];
    config.performance.maxRegressionPercent = 0;
    config.verification.benchmarks = [{
      id: "value-bench", symbols: ["value"], argv: ["value-benchmark"], warmup: 0, samples: 2,
    }];
    const transaction = new TransactionEngine({
      root, config, clang: fakeClang(root) as never, runner: timedRunner, getGeneration: () => 5,
      queueMutation: async (_path, operation) => operation(),
    });
    const result = await transaction.apply({
      generation: 5, headerRootHash: await hashHeaders(root),
      changes: [{ path: "src/value.c", expectedSha256: sha256(source), edits: [{ oldText: "return 1;", newText: "return 2;" }] }],
      evidence: await evidence(root),
    });
    expect(result.diagnostics[0]).toContain("performance_regression:value-bench");
    expect(await readFile(resolve(root, "src", "value.c"), "utf8")).toBe(source);
  });

  it("inserts only a technical TODO and rejects stale TODO writes", async () => {
    const { root, source } = await project();
    const transaction = engine(root, () => 4);
    const result = await transaction.todo({
      generation: 4,
      changes: [{ path: "src/value.c", expectedSha256: sha256(source), insertions: [{ line: 1, comment: "//@TODO: reason=ambiguous_contract symbol=value" }] }],
    });
    expect(result.status).toBe("todo");
    expect(await readFile(resolve(root, "src", "value.c"), "utf8")).toMatch(/^\/\/@TODO:/);
    const stale = await transaction.todo({
      generation: 4,
      changes: [{ path: "src/value.c", expectedSha256: sha256(source), insertions: [{ line: 1, comment: "//@NOTE: evidence=test" }] }],
    });
    expect(stale.status).toBe("rejected");
  });
});
