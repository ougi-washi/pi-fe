import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

export const SOURCE_SUFFIXES = new Set([".c", ".cpp"]);
export const HEADER_SUFFIXES = new Set([".h", ".hpp"]);
export const ACTIVE_TOOLS = [
  "read", "grep", "find", "ls", "cxx_contract", "cxx_check", "cxx_apply", "cxx_todo", "cxx_finalize",
] as const;
export const ACTIVE_TOOL_SET: ReadonlySet<string> = new Set(ACTIVE_TOOLS);

export interface TextEdit {
  oldText: string;
  newText: string;
}

export interface ResolvedSource {
  absolutePath: string;
  relativePath: string;
  sha256: string;
  content: string;
}

export interface ReplacementRange extends TextEdit {
  start: number;
  end: number;
}

export const TODO_PATTERN = /^\/\/@TODO: (?:[a-z][a-z0-9_]*=[^\s=]+)(?: [a-z][a-z0-9_]*=[^\s=]+)*$/;
export const NOTE_PATTERN = /^\/\/@NOTE: (?:[a-z][a-z0-9_]*=[^\s=]+)(?: [a-z][a-z0-9_]*=[^\s=]+)*$/;

export function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export function normalizeRelativePath(path: string): string {
  return path.split(sep).join("/");
}

export function isContained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** Resolve an existing source fail-closed: lexical escape, symlinks, non-files, and non-C/C++ paths are denied. */
export async function resolveExistingSource(root: string, inputPath: string): Promise<ResolvedSource> {
  if (typeof inputPath !== "string" || inputPath.length === 0 || inputPath.includes("\0")) throw new Error("invalid_path");
  const canonicalRoot = await realpath(root);
  const lexical = resolve(canonicalRoot, inputPath.replace(/^@/, ""));
  if (!isContained(canonicalRoot, lexical)) throw new Error("path_outside_repository");

  const lexicalInfo = await lstat(lexical).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error("source_create_denied");
    throw error;
  });
  if (lexicalInfo.isSymbolicLink()) throw new Error("symlink_denied");
  const canonical = await realpath(lexical);
  if (canonical !== lexical) throw new Error("symlink_component_denied");
  if (!isContained(canonicalRoot, canonical)) throw new Error("symlink_escape_denied");
  const info = await stat(canonical);
  if (!info.isFile()) throw new Error("not_regular_file");
  if (!SOURCE_SUFFIXES.has(extname(canonical).toLowerCase())) throw new Error("source_suffix_denied");

  const content = await readFile(canonical, "utf8");
  return {
    absolutePath: canonical,
    relativePath: normalizeRelativePath(relative(canonicalRoot, canonical)),
    sha256: sha256(content),
    content,
  };
}

export function locateUniqueReplacements(content: string, edits: readonly TextEdit[]): ReplacementRange[] {
  if (!Array.isArray(edits) || edits.length === 0) throw new Error("changes_required");
  const ranges: ReplacementRange[] = [];
  for (const edit of edits) {
    if (typeof edit.oldText !== "string" || typeof edit.newText !== "string") throw new Error("invalid_edit");
    if (edit.oldText.length === 0) throw new Error("empty_old_text_denied");
    if (edit.oldText === edit.newText) throw new Error("no_op_edit_denied");
    const start = content.indexOf(edit.oldText);
    if (start < 0) throw new Error("old_text_not_found");
    if (content.indexOf(edit.oldText, start + edit.oldText.length) >= 0) throw new Error("old_text_not_unique");
    ranges.push({ ...edit, start, end: start + edit.oldText.length });
  }
  ranges.sort((a, b) => a.start - b.start);
  for (let index = 1; index < ranges.length; index++) {
    const previous = ranges[index - 1];
    const current = ranges[index];
    if (previous && current && current.start < previous.end) throw new Error("overlapping_edits");
  }
  return ranges;
}

export function applyReplacements(content: string, ranges: readonly ReplacementRange[]): string {
  let output = content;
  for (const range of [...ranges].sort((a, b) => b.start - a.start)) {
    output = output.slice(0, range.start) + range.newText + output.slice(range.end);
  }
  return output;
}

export function lineStartOffsets(content: string): number[] {
  const offsets = [0];
  for (let index = 0; index < content.length; index++) if (content[index] === "\n") offsets.push(index + 1);
  return offsets;
}

export function offsetForLine(content: string, line: number): number {
  if (!Number.isInteger(line) || line < 1) throw new Error("invalid_line");
  const offsets = lineStartOffsets(content);
  if (line > offsets.length + 1) throw new Error("line_out_of_range");
  return line === offsets.length + 1 ? content.length : offsets[line - 1] ?? content.length;
}

export function validateTechnicalComment(comment: string): "todo" | "note" {
  if (comment.includes("\n") || comment.includes("\r")) throw new Error("multiline_comment_denied");
  if (TODO_PATTERN.test(comment)) return "todo";
  if (NOTE_PATTERN.test(comment)) return "note";
  throw new Error("invalid_technical_comment");
}

export function insertTechnicalComments(
  content: string,
  insertions: readonly { line: number; comment: string }[],
): { content: string; ranges: Array<{ start: number; end: number }> } {
  if (insertions.length === 0) throw new Error("insertions_required");
  const seen = new Set<string>();
  const prepared = insertions.map((insertion) => {
    validateTechnicalComment(insertion.comment);
    const key = `${insertion.line}:${insertion.comment}`;
    if (seen.has(key)) throw new Error("duplicate_insertion");
    seen.add(key);
    const offset = offsetForLine(content, insertion.line);
    const prefix = content.slice(0, offset);
    const previousLine = prefix.slice(prefix.lastIndexOf("\n", Math.max(0, prefix.length - 2)) + 1).trimEnd();
    if (previousLine.endsWith("\\")) throw new Error("comment_in_preprocessor_continuation_denied");
    let blockComment = false;
    let quote: "'" | '"' | undefined;
    let escaped = false;
    for (let index = 0; index < prefix.length; index++) {
      const current = prefix[index]!;
      const next = prefix[index + 1];
      if (blockComment) {
        if (current === "*" && next === "/") { blockComment = false; index++; }
        continue;
      }
      if (quote) {
        if (escaped) { escaped = false; continue; }
        if (current === "\\") { escaped = true; continue; }
        if (current === quote) quote = undefined;
        continue;
      }
      if (current === "/" && next === "*") { blockComment = true; index++; continue; }
      if (current === "/" && next === "/") {
        const newline = prefix.indexOf("\n", index + 2);
        if (newline < 0) break;
        index = newline;
        continue;
      }
      if (current === "'" || current === '"') quote = current;
    }
    if (blockComment || quote || /R"[^\n(]*\([^)]*$/.test(prefix)) throw new Error("comment_inside_token_denied");
    return { ...insertion, offset };
  }).sort((a, b) => b.offset - a.offset || b.line - a.line);
  let output = content;
  const ranges: Array<{ start: number; end: number }> = [];
  for (const insertion of prepared) {
    const text = `${insertion.comment}\n`;
    output = output.slice(0, insertion.offset) + text + output.slice(insertion.offset);
    ranges.push({ start: insertion.offset, end: insertion.offset + text.length });
  }
  return { content: output, ranges };
}

export async function hashFile(path: string): Promise<string> {
  return sha256(await readFile(path));
}

export async function hashHeaders(root: string, paths?: readonly string[]): Promise<string> {
  const canonicalRoot = await realpath(root);
  let headerPaths: string[];
  if (paths) {
    headerPaths = [...new Set(paths.map((path) => resolve(canonicalRoot, path)))];
  } else {
    headerPaths = [];
    const { readdir } = await import("node:fs/promises");
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "vendor") continue;
        const path = resolve(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error("repository_symlink_denied");
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile() && HEADER_SUFFIXES.has(extname(entry.name).toLowerCase())) headerPaths.push(path);
      }
    };
    await walk(canonicalRoot);
  }
  const hash = createHash("sha256");
  for (const path of headerPaths.sort()) {
    if (!isContained(canonicalRoot, path)) throw new Error("header_path_outside_repository");
    const canonical = await realpath(path);
    if (canonical !== path || !isContained(canonicalRoot, canonical)) throw new Error("header_symlink_denied");
    const info = await stat(canonical);
    if (!info.isFile() || !HEADER_SUFFIXES.has(extname(canonical).toLowerCase())) throw new Error("invalid_header_path");
    const rel = normalizeRelativePath(relative(canonicalRoot, canonical));
    hash.update(rel).update("\0").update(await readFile(canonical)).update("\0");
  }
  return hash.digest("hex");
}

export function changedLineRanges(content: string, ranges: readonly { start: number; end: number }[]): Array<{ start: number; end: number }> {
  const offsets = lineStartOffsets(content);
  const lineAt = (offset: number): number => {
    let low = 0;
    let high = offsets.length;
    while (low + 1 < high) {
      const middle = (low + high) >>> 1;
      if ((offsets[middle] ?? 0) <= offset) low = middle;
      else high = middle;
    }
    return low + 1;
  };
  return ranges.map((range) => ({ start: lineAt(range.start), end: lineAt(Math.max(range.start, range.end - 1)) }));
}
