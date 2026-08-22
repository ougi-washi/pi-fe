import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { stripAssistantProse } from "../src/index.js";
import { parseConfig } from "../src/config.js";
import {
  applyReplacements, hashHeaders, insertTechnicalComments, locateUniqueReplacements, resolveExistingSource,
  sha256, validateTechnicalComment,
} from "../src/policy.js";

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "pi-fe-policy-"));
  await mkdir(resolve(root, "src"));
  await mkdir(resolve(root, "include"));
  await writeFile(resolve(root, "src", "ok.cpp"), "int value() { return 1; }\n");
  await writeFile(resolve(root, "include", "ok.hpp"), "int value();\n");
  return root;
}

describe("strict path policy", () => {
  it("allows only existing regular .c/.cpp files", async () => {
    const root = await fixtureRoot();
    const source = await resolveExistingSource(root, "src/ok.cpp");
    expect(source.relativePath).toBe("src/ok.cpp");
    expect(source.sha256).toBe(sha256(source.content));
    await expect(resolveExistingSource(root, "src/new.cpp")).rejects.toThrow("source_create_denied");
    await expect(resolveExistingSource(root, "include/ok.hpp")).rejects.toThrow("source_suffix_denied");
    await expect(resolveExistingSource(root, "../outside.cpp")).rejects.toThrow("path_outside_repository");
  });

  it("rejects symlinks, including aliases that remain inside the repository", async () => {
    const root = await fixtureRoot();
    await symlink(resolve(root, "src", "ok.cpp"), resolve(root, "src", "alias.cpp"));
    await expect(resolveExistingSource(root, "src/alias.cpp")).rejects.toThrow("symlink_denied");
    await mkdir(resolve(root, "real"));
    await writeFile(resolve(root, "real", "nested.cpp"), "int nested() { return 1; }\n");
    await symlink(resolve(root, "real"), resolve(root, "alias-dir"));
    await expect(resolveExistingSource(root, "alias-dir/nested.cpp")).rejects.toThrow("symlink_component_denied");
  });

  it("requires unique non-overlapping exact replacements", () => {
    expect(() => locateUniqueReplacements("x x", [{ oldText: "x", newText: "y" }])).toThrow("old_text_not_unique");
    expect(() => locateUniqueReplacements("abcdef", [
      { oldText: "abcd", newText: "x" },
      { oldText: "cdef", newText: "y" },
    ])).toThrow("overlapping_edits");
    const ranges = locateUniqueReplacements("abc", [{ oldText: "b", newText: "B" }]);
    expect(applyReplacements("abc", ranges)).toBe("aBc");
  });

  it("accepts only technical TODO/NOTE grammar and inserts whole comment lines", () => {
    expect(validateTechnicalComment("//@TODO: reason=ambiguous_contract symbol=Widget::update")).toBe("todo");
    expect(validateTechnicalComment("//@NOTE: evidence=test path=test/a.cpp:2")).toBe("note");
    expect(() => validateTechnicalComment("// TODO later")).toThrow("invalid_technical_comment");
    expect(insertTechnicalComments("int x;\n", [{ line: 1, comment: "//@TODO: reason=ambiguous_contract" }]).content)
      .toBe("//@TODO: reason=ambiguous_contract\nint x;\n");
    expect(() => insertTechnicalComments("#define X \\\n  1\n", [{ line: 2, comment: "//@TODO: reason=macro" }]))
      .toThrow("comment_in_preprocessor_continuation_denied");
  });

  it("changes the header Merkle root for content changes", async () => {
    const root = await fixtureRoot();
    const first = await hashHeaders(root);
    await writeFile(resolve(root, "include", "ok.hpp"), "int value() noexcept;\n");
    expect(await hashHeaders(root)).not.toBe(first);
  });

  it("accepts argv commands but rejects raw shell executables in trusted configuration", () => {
    expect(parseConfig({ verification: { tests: [{ id: "ok", paths: ["src/a.cpp"], argv: ["ctest", "-R", "a"] }] } }).verification.tests).toHaveLength(1);
    expect(() => parseConfig({ verification: { tests: [{ id: "bad", paths: ["src/a.cpp"], argv: ["bash", "-c", "touch x"] }] } }))
      .toThrow("raw shell executables are denied");
  });

  it("removes persisted prose and reasoning while preserving exact tool calls", () => {
    const toolCall = { type: "toolCall" as const, id: "call-1", name: "cxx_finalize", arguments: { status: "unchanged" } };
    const message = {
      role: "assistant" as const,
      content: [
        { type: "thinking" as const, thinking: "private" },
        { type: "text" as const, text: "visible prose" },
        toolCall,
      ],
      api: "test",
      provider: "test",
      model: "test",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse" as const,
      timestamp: 0,
    };
    expect(stripAssistantProse(message).content).toEqual([toolCall]);
  });
});
