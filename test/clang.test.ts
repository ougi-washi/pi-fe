import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { ClangEngine, CompileDatabaseError, type CommandRunner, discoverCompileDatabase } from "../src/clang.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { hashHeaders, sha256 } from "../src/policy.js";
import { TransactionEngine } from "../src/transaction.js";

const execFileAsync = promisify(execFile);
const runner: CommandRunner = async (command, args, options) => {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      ...(options.timeout ? { timeout: options.timeout } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string; code?: number; killed?: boolean };
    return {
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
      code: typeof failure.code === "number" ? failure.code : 1,
      ...(failure.killed === undefined ? {} : { killed: failure.killed }),
    };
  }
};

async function cppProject(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "pi-fe-clang-"));
  await mkdir(resolve(root, "src"));
  await mkdir(resolve(root, "include"));
  await mkdir(resolve(root, "build"));
  await writeFile(resolve(root, "include", "widget.hpp"), "// contract: test_fixture_expected_increment\nclass Widget { public: int update(int value) const; };\n");
  await writeFile(resolve(root, "src", "widget.cpp"), "#include \"widget.hpp\"\nint Widget::update(int value) const { return value; }\n");
  await writeFile(resolve(root, "build", "compile_commands.json"), JSON.stringify([{
    directory: root,
    file: resolve(root, "src", "widget.cpp"),
    arguments: ["clang++", "-std=c++17", `-I${resolve(root, "include")}`, "-c", resolve(root, "src", "widget.cpp"), "-o", resolve(root, "build", "widget.o")],
  }]));
  return root;
}

describe("Clang contract engine", () => {
  it("extracts an exact header declaration, source definition, body range, and stable header hash", async () => {
    const root = await cppProject();
    const engine = new ClangEngine(root, "build/compile_commands.json", runner);
    const contract = await engine.contract("src/widget.cpp");
    expect(contract.declarations.some((decl) => decl.qualifiedName === "Widget::update" && decl.path === "include/widget.hpp" && !decl.definition)).toBe(true);
    expect(contract.definitions.some((decl) => decl.qualifiedName === "Widget::update" && decl.path === "src/widget.cpp")).toBe(true);
    expect(contract.bodyRanges.some((range) => range.path === "src/widget.cpp" && range.end > range.start)).toBe(true);
    expect(contract.headerRootHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("extracts C contracts and marks source template definitions as non-editable templates", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "pi-fe-clang-c-"));
    await mkdir(resolve(root, "build"));
    await writeFile(resolve(root, "plain.h"), "int increment(int value);\n");
    await writeFile(resolve(root, "plain.c"), "#include \"plain.h\"\nint increment(int value) { return value + 1; }\n");
    await writeFile(resolve(root, "template.cpp"), "template <typename T> T identity(T value) { return value; }\ntemplate int identity<int>(int);\n");
    await writeFile(resolve(root, "build", "compile_commands.json"), JSON.stringify([
      { directory: root, file: resolve(root, "plain.c"), arguments: ["clang", "-c", resolve(root, "plain.c")] },
      { directory: root, file: resolve(root, "template.cpp"), arguments: ["clang++", "-std=c++17", "-c", resolve(root, "template.cpp")] },
    ]));
    const engine = new ClangEngine(root, "build/compile_commands.json", runner);
    expect((await engine.contract("plain.c")).definitions.some((decl) => decl.qualifiedName === "increment")).toBe(true);
    expect((await engine.contract("template.cpp")).definitions.some((decl) => decl.qualifiedName === "identity" && decl.template)).toBe(true);
  });

  it("fails closed for macro-generated definition ranges", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "pi-fe-clang-macro-"));
    await mkdir(resolve(root, "build"));
    await writeFile(resolve(root, "macro.cpp"), "#define DEFINE_VALUE(name) int name() { return 1; }\nDEFINE_VALUE(generated)\n");
    await writeFile(resolve(root, "build", "compile_commands.json"), JSON.stringify([{
      directory: root, file: resolve(root, "macro.cpp"), arguments: ["clang++", "-c", resolve(root, "macro.cpp")],
    }]));
    const engine = new ClangEngine(root, "build/compile_commands.json", runner);
    await expect(engine.contract("macro.cpp")).rejects.toThrow("macro_generated_ast_range");
  });

  it("verifies and commits a real Clang-backed body edit in a temporary workspace", async () => {
    const root = await cppProject();
    const sourcePath = resolve(root, "src", "widget.cpp");
    const headerPath = resolve(root, "include", "widget.hpp");
    const source = await readFile(sourcePath, "utf8");
    const clang = new ClangEngine(root, "build/compile_commands.json", runner);
    const transaction = new TransactionEngine({
      root,
      config: structuredClone(DEFAULT_CONFIG),
      clang,
      runner,
      getGeneration: () => 1,
      queueMutation: async (_path, operation) => operation(),
    });
    const result = await transaction.apply({
      generation: 1,
      headerRootHash: await hashHeaders(root),
      changes: [{ path: "src/widget.cpp", expectedSha256: sha256(source), edits: [{ oldText: "return value;", newText: "return value + 1;" }] }],
      evidence: [
        { kind: "header_decl", path: "include/widget.hpp", line: 2, sha256: sha256(await readFile(headerPath)), symbol: "Widget::update" },
        { kind: "header_contract", path: "include/widget.hpp", line: 1, sha256: sha256(await readFile(headerPath)), symbol: "Widget::update", constraint: "test_fixture_expected_increment" },
      ],
    });
    expect(result.status, result.diagnostics.join("\n")).toBe("changed");
    expect(await readFile(sourcePath, "utf8")).toContain("return value + 1;");
  });

  it("invalidates cached AST contracts when an included header changes", async () => {
    const root = await cppProject();
    const engine = new ClangEngine(root, "build/compile_commands.json", runner);
    const first = await engine.contract("src/widget.cpp");
    await writeFile(resolve(root, "include", "widget.hpp"), "// contract: test_fixture_expected_increment\nclass Widget { public: int update(int value) const; int size() const; };\n");
    const second = await engine.contract("src/widget.cpp");
    expect(second.headerRootHash).not.toBe(first.headerRootHash);
    expect(second.declarations.some((decl) => decl.qualifiedName === "Widget::size")).toBe(true);
  });

  it("fails closed when more than one compile database exists", async () => {
    const root = await cppProject();
    await mkdir(resolve(root, "other"));
    await writeFile(resolve(root, "other", "compile_commands.json"), "[]");
    await expect(discoverCompileDatabase(root, "build/compile_commands.json")).rejects.toThrow("multiple_compile_databases");
  });

  it("rejects command entries containing shell syntax rather than executing them", async () => {
    const root = await cppProject();
    await writeFile(resolve(root, "build", "compile_commands.json"), JSON.stringify([{
      directory: root,
      file: resolve(root, "src", "widget.cpp"),
      command: `clang++ -c ${resolve(root, "src", "widget.cpp")} ; touch pwned`,
    }]));
    const engine = new ClangEngine(root, "build/compile_commands.json", runner);
    await expect(engine.contract("src/widget.cpp")).rejects.toBeInstanceOf(CompileDatabaseError);
    await expect(readFile(resolve(root, "pwned"), "utf8")).rejects.toThrow();
  });
});
