import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, cp, lstat, mkdtemp, open, readFile, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, matchesGlob, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { PiFeConfig } from "./config.js";
import {
  type AstAnalysis, type AstDeclaration, ClangEngine, type CommandRunner, type CompileCommand, countDiagnostics,
  declarationKey,
} from "./clang.js";
import {
  type ReplacementRange, type TextEdit, applyReplacements, changedLineRanges, hashFile, hashHeaders, insertTechnicalComments,
  isContained, locateUniqueReplacements, normalizeRelativePath, resolveExistingSource, sha256, validateTechnicalComment,
} from "./policy.js";

export interface Evidence {
  kind: string;
  path: string;
  line?: number;
  sha256: string;
  symbol?: string;
  constraint?: string;
}

export interface FileChange {
  path: string;
  expectedSha256: string;
  edits: TextEdit[];
}

export interface TodoChange {
  path: string;
  expectedSha256: string;
  insertions: Array<{ line: number; comment: string }>;
}

export interface CheckRecord {
  id: string;
  status: "pass" | "fail" | "baseline-fail" | "skipped";
  diagnostics?: string[];
  durationMs?: number;
}

export interface ApplyResult {
  status: "changed" | "todo" | "rejected" | "failed";
  changed: string[];
  checks: CheckRecord[];
  diagnostics: string[];
  performance: { status: "pass" | "unverified"; reason?: string };
  hashes: Record<string, string>;
}

export interface TransactionOptions {
  root: string;
  config: PiFeConfig;
  clang: ClangEngine;
  runner: CommandRunner;
  getGeneration: () => number;
  queueMutation: <T>(path: string, operation: () => Promise<T>) => Promise<T>;
  onCommit?: (path: string, hash: string) => void;
}

interface Candidate {
  path: string;
  absolutePath: string;
  original: string;
  originalHash: string;
  candidate: string;
  candidateHash: string;
  ranges: ReplacementRange[];
  contract?: Awaited<ReturnType<ClangEngine["contract"]>>;
  candidateAst?: AstAnalysis;
}

function stringSetEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(left);
  return right.every((value) => expected.has(value));
}

function hasNewDiagnostics(original: AstAnalysis["diagnostics"], candidate: AstAnalysis["diagnostics"]): boolean {
  const counts = new Map<string, number>();
  for (const diagnostic of original) {
    if (diagnostic.severity !== "error" && diagnostic.severity !== "warning") continue;
    const key = `${diagnostic.severity}:${diagnostic.message}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const diagnostic of candidate) {
    if (diagnostic.severity !== "error" && diagnostic.severity !== "warning") continue;
    const key = `${diagnostic.severity}:${diagnostic.message}`;
    const remaining = counts.get(key) ?? 0;
    if (remaining === 0) return true;
    counts.set(key, remaining - 1);
  }
  return false;
}

function metricIncreases(original: AstAnalysis, candidate: AstAnalysis): string[] {
  const oldBySymbol = new Map(original.metrics.map((metric) => [metric.symbol, metric]));
  const increases: string[] = [];
  for (const metric of candidate.metrics) {
    const baseline = oldBySymbol.get(metric.symbol);
    if (!baseline) continue;
    for (const key of Object.keys(metric) as Array<keyof typeof metric>) {
      if (key === "symbol") continue;
      if (metric[key] > baseline[key]) increases.push(`${metric.symbol}:${key}:${baseline[key]}->${metric[key]}`);
    }
  }
  return increases;
}

function declarationsByKey(declarations: readonly AstDeclaration[]): Map<string, AstDeclaration[]> {
  const map = new Map<string, AstDeclaration[]>();
  for (const declaration of declarations) {
    const key = declarationKey(declaration);
    const values = map.get(key) ?? [];
    values.push(declaration);
    map.set(key, values);
  }
  return map;
}

function hasDeniedPreprocessorDirective(edit: TextEdit): boolean {
  return [edit.oldText, edit.newText].some((text) => text.split(/\r?\n/).some((line) =>
    /^\s*#/.test(line) && !/^\s*#\s*include\s*[<"][^>"]+[>"]/.test(line)));
}

function onlyIncludesOrTechnicalComments(edit: TextEdit): boolean {
  const classify = (text: string): { accepted: boolean; includes: string[] } => {
    const includes: string[] = [];
    const accepted = text.split(/\r?\n/).every((line) => {
      const trimmed = line.trim();
      if (trimmed === "" || /^\/\/@(?:TODO|NOTE): /.test(trimmed)) return true;
      if (/^#\s*include\s*[<"][^>"]+[>"](?:\s*\/\/.*)?$/.test(trimmed)) {
        includes.push(trimmed);
        return true;
      }
      return false;
    });
    return { accepted, includes };
  };
  const before = classify(edit.oldText);
  const after = classify(edit.newText);
  if (before.accepted && after.accepted && before.includes.every((include) => after.includes.includes(include))) return true;
  const anchor = edit.newText.indexOf(edit.oldText);
  if (anchor < 0 || edit.newText.indexOf(edit.oldText, anchor + edit.oldText.length) >= 0) return false;
  const inserted = edit.newText.slice(0, anchor) + edit.newText.slice(anchor + edit.oldText.length);
  const addition = classify(inserted);
  return addition.accepted && addition.includes.length > 0;
}

function remapArgument(arg: string, root: string, workspace: string): string {
  if (arg === root || arg.startsWith(`${root}/`)) return workspace + arg.slice(root.length);
  const prefixes = ["-I", "-isystem", "-iquote", "-include"];
  for (const prefix of prefixes) {
    if (arg.startsWith(prefix) && arg.slice(prefix.length).startsWith(root)) {
      return prefix + workspace + arg.slice(prefix.length + root.length);
    }
  }
  return arg;
}

function remapCommand(command: CompileCommand, root: string, workspace: string): CompileCommand {
  const mappedFile = resolve(workspace, relative(root, command.file));
  const mappedDirectory = isContained(root, command.directory)
    ? resolve(workspace, relative(root, command.directory)) : command.directory;
  return {
    ...command,
    directory: mappedDirectory,
    file: mappedFile,
    arguments: command.arguments.map((arg) => remapArgument(arg, root, workspace)),
  };
}

async function copyWorkspace(root: string): Promise<string> {
  const workspace = await mkdtemp(resolve(tmpdir(), "pi-fe-verify-"));
  await cp(root, workspace, {
    recursive: true,
    preserveTimestamps: true,
    filter: async (source) => {
      const rel = normalizeRelativePath(relative(root, source));
      if (rel === ".git" || rel.startsWith(".git/") || rel === "node_modules" || rel.startsWith("node_modules/")) return false;
      return !(await lstat(source)).isSymbolicLink();
    },
  });
  return workspace;
}

async function executableAvailable(command: string): Promise<boolean> {
  if (isAbsolute(command)) return access(command, constants.X_OK).then(() => true, () => false);
  const path = process.env.PATH ?? "";
  for (const directory of path.split(":")) {
    if (await access(resolve(directory, command), constants.X_OK).then(() => true, () => false)) return true;
  }
  return false;
}

function pathMatches(path: string, pattern: string): boolean {
  try { return matchesGlob(path, pattern); } catch { return path === pattern; }
}

function mappedTests(config: PiFeConfig, paths: readonly string[]) {
  return config.verification.tests.filter((test) => test.paths.some((pattern) => paths.some((path) => pathMatches(path, pattern))));
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : sorted[middle] ?? 0;
}

function remapArgv(argv: [string, ...string[]], root: string, workspace: string): [string, ...string[]] {
  return argv.map((argument) => remapArgument(argument, root, workspace)) as [string, ...string[]];
}

async function runMappedCommand(
  runner: CommandRunner,
  argv: [string, ...string[]],
  cwd: string,
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined,
): Promise<{ code: number; stderr: string; stdout: string; durationMs: number }> {
  const started = performance.now();
  const result = await runner(argv[0], argv.slice(1), { cwd, ...(timeoutMs ? { timeout: timeoutMs } : {}), ...(signal ? { signal } : {}) });
  return { ...result, durationMs: performance.now() - started };
}

async function atomicWrite(path: string, content: string, mode: number): Promise<void> {
  const temporary = resolve(dirname(path), `.${randomBytes(12).toString("hex")}.pi-fe-tmp`);
  const handle = await open(temporary, "wx", mode);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export class TransactionEngine {
  private serial: Promise<void> = Promise.resolve();

  constructor(private readonly options: TransactionOptions) {}

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.serial;
    let release!: () => void;
    this.serial = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    await previous;
    try { return await operation(); } finally { release(); }
  }

  private assertGeneration(generation: number): void {
    if (!Number.isInteger(generation) || generation !== this.options.getGeneration()) throw new Error("stale_input");
  }

  private async queuePaths<T>(paths: readonly string[], operation: () => Promise<T>): Promise<T> {
    const targets = [...new Set(paths.map((path) => resolve(this.options.root, path.replace(/^@/, ""))))].sort();
    const acquire = async (index: number): Promise<T> => {
      const target = targets[index];
      if (!target) return operation();
      return this.options.queueMutation(target, () => acquire(index + 1));
    };
    return acquire(0);
  }

  private async verifyEvidence(evidence: readonly Evidence[]): Promise<void> {
    if (!evidence.some((item) => item.kind === "header_decl")) throw new Error("header_declaration_evidence_required");
    const canonicalRoot = await realpath(this.options.root);
    for (const item of evidence) {
      const path = await realpath(resolve(canonicalRoot, item.path));
      if (!isContained(canonicalRoot, path)) throw new Error("evidence_outside_repository");
      const info = await stat(path);
      if (!info.isFile() || await hashFile(path) !== item.sha256) throw new Error("stale_evidence");
      if (item.line !== undefined && (!Number.isInteger(item.line) || item.line < 1)) throw new Error("invalid_evidence_line");
      if (["header_contract", "test", "call_site", "sibling", "documentation"].includes(item.kind)) {
        if (item.line === undefined || item.constraint === undefined) throw new Error("behavioral_evidence_location_required");
        const line = (await readFile(path, "utf8")).split(/\r?\n/)[item.line - 1];
        if (line === undefined || !line.includes(item.constraint)) throw new Error("behavioral_evidence_not_present_at_line");
      }
    }
  }

  private async prepare(changes: readonly FileChange[]): Promise<Candidate[]> {
    if (changes.length === 0) throw new Error("changes_required");
    const candidates: Candidate[] = [];
    const seen = new Set<string>();
    for (const change of changes) {
      const source = await resolveExistingSource(this.options.root, change.path);
      if (seen.has(source.absolutePath)) throw new Error("duplicate_change_path");
      seen.add(source.absolutePath);
      if (source.sha256 !== change.expectedSha256) throw new Error("stale_source");
      const ranges = locateUniqueReplacements(source.content, change.edits);
      const candidate = applyReplacements(source.content, ranges);
      candidates.push({
        path: source.relativePath, absolutePath: source.absolutePath, original: source.content, originalHash: source.sha256,
        candidate, candidateHash: sha256(candidate), ranges,
      });
    }
    return candidates.sort((a, b) => a.absolutePath.localeCompare(b.absolutePath));
  }

  private validateStructure(candidate: Candidate, evidence: readonly Evidence[]): void {
    const original = candidate.contract!;
    const next = candidate.candidateAst!;
    if (!stringSetEqual(original.forbiddenSurface, next.forbiddenSurface)) throw new Error("structural_declaration_change");

    const oldExports = new Set(original.exportedSymbols);
    const newExports = new Set(next.exportedSymbols);
    for (const symbol of oldExports) if (!newExports.has(symbol)) throw new Error("exported_symbol_removed");
    const originalDeclarations = declarationsByKey(original.declarations);
    for (const symbol of newExports) {
      if (oldExports.has(symbol)) continue;
      const declarations = originalDeclarations.get(symbol) ?? [];
      if (!declarations.some((decl) => !isAbsolute(decl.path) && [".h", ".hpp"].includes(extname(decl.path).toLowerCase()) && !decl.definition)) {
        throw new Error("unmatched_new_exported_symbol");
      }
    }

    const sourceBodyEntries = original.bodyRanges
      .map((range) => ({ range, definition: original.definitions.find((item) => declarationKey(item) === range.symbolKey) }))
      .filter((entry) => entry.range.path === candidate.path);
    const sourceBodyRanges = sourceBodyEntries.map((entry) => entry.range);
    const touchedDefinitions = sourceBodyEntries
      .filter((entry) => candidate.ranges.some((range) => range.start < entry.range.end && range.end > entry.range.start))
      .map((entry) => entry.definition)
      .filter((definition): definition is AstDeclaration => definition !== undefined);
    const headerDeclarations = original.declarations.filter((decl) =>
      !isAbsolute(decl.path) && [".h", ".hpp"].includes(extname(decl.path).toLowerCase()) && !decl.definition);
    for (const definition of touchedDefinitions) {
      if (definition.template) throw new Error(`template_edit_denied:${definition.qualifiedName}`);
      const declaration = headerDeclarations.find((item) => declarationKey(item) === declarationKey(definition));
      if (!declaration) throw new Error(`exact_header_declaration_required:${definition.qualifiedName}`);
      const supported = evidence.some((item) => item.kind === "header_decl" &&
        normalizeRelativePath(relative(this.options.root, resolve(this.options.root, item.path.replace(/^@/, "")))) === declaration.path &&
        (item.line === undefined || declaration.line === undefined || item.line === declaration.line) &&
        (item.symbol === undefined || item.symbol === declaration.qualifiedName || item.symbol === declaration.name));
      if (!supported) throw new Error(`header_declaration_evidence_mismatch:${definition.qualifiedName}`);
      const behavioral = evidence.some((item) =>
        ["header_contract", "test", "call_site", "sibling", "documentation"].includes(item.kind) &&
        item.constraint !== undefined &&
        (item.symbol === definition.qualifiedName || item.symbol === definition.name));
      if (!behavioral) throw new Error(`behavioral_evidence_required:${definition.qualifiedName}`);
    }
    const originalSourceDefinitions = original.definitions.filter((definition) => definition.path === candidate.path);
    const candidateSourceDefinitions = new Map(next.definitions.filter((definition) => definition.path === candidate.path).map((definition) => [declarationKey(definition), definition]));
    for (const definition of originalSourceDefinitions) {
      if (!candidateSourceDefinitions.has(declarationKey(definition))) throw new Error(`existing_definition_removed:${definition.qualifiedName}`);
    }
    const originalDefinitions = new Set(original.definitions.map(declarationKey));
    const addedDefinitions = next.definitions.filter((decl) => decl.path === candidate.path && !originalDefinitions.has(declarationKey(decl)));
    const exactHeaderDeclarations = new Set(headerDeclarations.map(declarationKey));
    for (const definition of addedDefinitions) {
      if (!exactHeaderDeclarations.has(declarationKey(definition))) throw new Error("definition_without_exact_header_declaration");
      const declaration = headerDeclarations.find((item) => declarationKey(item) === declarationKey(definition));
      const supported = declaration && evidence.some((item) => item.kind === "header_decl" &&
        normalizeRelativePath(relative(this.options.root, resolve(this.options.root, item.path.replace(/^@/, "")))) === declaration.path &&
        (item.symbol === undefined || item.symbol === declaration.qualifiedName || item.symbol === declaration.name));
      if (!supported) throw new Error(`definition_header_evidence_mismatch:${definition.qualifiedName}`);
      const behavioral = evidence.some((item) =>
        ["header_contract", "test", "call_site", "sibling", "documentation"].includes(item.kind) &&
        item.constraint !== undefined &&
        (item.symbol === definition.qualifiedName || item.symbol === definition.name));
      if (!behavioral) throw new Error(`behavioral_evidence_required:${definition.qualifiedName}`);
    }

    let cumulativeDelta = 0;
    for (const range of candidate.ranges) {
      if (hasDeniedPreprocessorDirective(range)) throw new Error("preprocessor_edit_denied");
      const inBody = sourceBodyRanges.some((body) => range.start >= body.start && range.end <= body.end);
      const editIsMetadata = onlyIncludesOrTechnicalComments(range);
      const candidateStart = range.start + cumulativeDelta;
      const candidateEnd = candidateStart + range.newText.length;
      cumulativeDelta += range.newText.length - range.oldText.length;
      const isDefinition = addedDefinitions.some((decl) => decl.sourceRange !== undefined &&
        decl.sourceRange.start >= candidateStart && decl.sourceRange.end <= candidateEnd &&
        exactHeaderDeclarations.has(declarationKey(decl)));
      if (!inBody && !editIsMetadata && !isDefinition) throw new Error("edit_outside_permitted_ast_range");
    }

    const originalNonDefinitions = new Map<string, number>();
    for (const declaration of original.declarations.filter((item) => !item.definition && !isAbsolute(item.path))) {
      const key = `${declarationKey(declaration)}|${declaration.kind}|${declaration.path}`;
      originalNonDefinitions.set(key, (originalNonDefinitions.get(key) ?? 0) + 1);
    }
    const candidateNonDefinitions = new Map<string, number>();
    for (const declaration of next.declarations.filter((item) => !item.definition && !isAbsolute(item.path))) {
      const key = `${declarationKey(declaration)}|${declaration.kind}|${declaration.path}`;
      candidateNonDefinitions.set(key, (candidateNonDefinitions.get(key) ?? 0) + 1);
    }
    if (!stringSetEqual(
      [...originalNonDefinitions].map(([key, count]) => `${key}|${count}`).sort(),
      [...candidateNonDefinitions].map(([key, count]) => `${key}|${count}`).sort(),
    )) throw new Error("function_declaration_change");

    const increases = metricIncreases(original, next);
    const performanceEvidence = evidence.some((item) => item.kind === "performance" || item.kind === "test" && item.constraint?.includes("performance"));
    if (increases.length > 0 && !performanceEvidence) throw new Error(`performance_evidence_required:${increases.join(",")}`);
  }

  private async verifyCandidates(candidates: Candidate[], evidence: readonly Evidence[], signal?: AbortSignal): Promise<{ checks: CheckRecord[]; workspace: string; baselineWorkspace: string; benchmarksRun: number }> {
    const workspace = await copyWorkspace(this.options.root);
    const baselineWorkspace = await copyWorkspace(this.options.root);
    const checks: CheckRecord[] = [];
    const touchedSymbols = new Set<string>();
    try {
      for (const candidate of candidates) await writeFile(resolve(workspace, candidate.path), candidate.candidate, "utf8");
      for (const candidate of candidates) {
        const contract = await this.options.clang.contract(candidate.path, signal);
        candidate.contract = contract;
        const mapped = remapCommand(contract.compileCommand, await realpath(this.options.root), workspace);
        const ast = await this.options.clang.analyzeCandidate(mapped, mapped.file, signal, workspace);
        candidate.candidateAst = ast;
        this.validateStructure(candidate, evidence);
        contract.bodyRanges.forEach((body) => {
          if (body.path !== candidate.path) return;
          if (candidate.ranges.some((range) => range.start < body.end && range.end > body.start) && body.symbol) {
            touchedSymbols.add(body.symbol);
          }
        });
        const pass = !hasNewDiagnostics(contract.diagnostics, ast.diagnostics);
        checks.push({
          id: `compile:${candidate.path}`, status: pass ? "pass" : "fail",
          diagnostics: ast.diagnostics.map((item) => `${item.severity}:${item.message}`).slice(0, 100),
        });
        if (!pass) throw new Error("new_compiler_diagnostics");

        const clangFormat = resolve(this.options.root, ".clang-format");
        if (await access(clangFormat).then(() => true, () => false) && await executableAvailable("clang-format")) {
          const lines = changedLineRanges(candidate.original, candidate.ranges);
          const argv = ["--dry-run", "--Werror", ...lines.flatMap((line) => [`--lines=${line.start}:${line.end}`]), mapped.file];
          const result = await this.options.runner("clang-format", argv, { cwd: mapped.directory, ...(signal ? { signal } : {}) });
          checks.push({ id: `clang-format:${candidate.path}`, status: result.code === 0 ? "pass" : "fail", diagnostics: result.stderr ? [result.stderr] : [] });
          if (result.code !== 0) throw new Error("changed_range_format_failure");
        }
      }

      if (await access(resolve(this.options.root, ".clang-tidy")).then(() => true, () => false) && await executableAvailable("clang-tidy")) {
        const writeMappedDatabase = async (target: string): Promise<string> => {
          const mappedCommands = candidates.map((candidate) => {
            const command = remapCommand(candidate.contract!.compileCommand, this.options.root, target);
            return { directory: command.directory, file: command.file, arguments: [command.executable, ...command.arguments] };
          });
          const database = resolve(target, relative(this.options.root, candidates[0]!.contract!.compileCommand.databasePath));
          await writeFile(database, JSON.stringify(mappedCommands), "utf8");
          return database;
        };
        const mappedDatabase = await writeMappedDatabase(workspace);
        const baselineDatabase = await writeMappedDatabase(baselineWorkspace);
        const issues = (output: string): string[] => output.split(/\r?\n/)
          .filter((line) => /:\d+:\d+: (?:warning|error):/.test(line))
          .map((line) => line.replace(workspace, "<ROOT>").replace(baselineWorkspace, "<ROOT>").replace(/^.*?:\d+:\d+: /, ""))
          .sort();
        for (const candidate of candidates) {
          const baseline = await this.options.runner("clang-tidy", [resolve(baselineWorkspace, candidate.path), `-p=${dirname(baselineDatabase)}`], { cwd: baselineWorkspace, ...(signal ? { signal } : {}) });
          const next = await this.options.runner("clang-tidy", [resolve(workspace, candidate.path), `-p=${dirname(mappedDatabase)}`], { cwd: workspace, ...(signal ? { signal } : {}) });
          const baselineIssues = issues(`${baseline.stdout}\n${baseline.stderr}`);
          const nextIssues = issues(`${next.stdout}\n${next.stderr}`);
          const pass = nextIssues.length <= baselineIssues.length && nextIssues.every((issue) => baselineIssues.includes(issue));
          checks.push({ id: `clang-tidy:${candidate.path}`, status: pass ? "pass" : "fail", diagnostics: next.stderr ? [next.stderr] : [] });
          if (!pass) throw new Error("new_static_analysis_issue");
        }
      }

      for (const test of mappedTests(this.options.config, candidates.map((item) => item.path))) {
        const baseline = await runMappedCommand(this.options.runner, remapArgv(test.argv, this.options.root, baselineWorkspace), baselineWorkspace, test.timeoutMs, signal);
        const next = await runMappedCommand(this.options.runner, remapArgv(test.argv, this.options.root, workspace), workspace, test.timeoutMs, signal);
        const normalizeOutput = (output: string): string => output
          .split(workspace).join("<ROOT>")
          .split(this.options.root).join("<ROOT>")
          .trim();
        const sameBaselineFailure = baseline.code !== 0 && next.code === baseline.code &&
          normalizeOutput(`${baseline.stdout}\n${baseline.stderr}`) === normalizeOutput(`${next.stdout}\n${next.stderr}`);
        const status = next.code === 0 ? "pass" : sameBaselineFailure ? "baseline-fail" : "fail";
        checks.push({ id: `test:${test.id}`, status, diagnostics: next.stderr ? [next.stderr] : [], durationMs: next.durationMs });
        if (baseline.code === 0 && next.code !== 0 || baseline.code !== 0 && !sameBaselineFailure && next.code !== 0) throw new Error("new_test_failure");
      }

      const changedPaths = candidates.map((item) => item.path);
      const benchmarkMappings = this.options.config.verification.benchmarks.filter((benchmark) =>
        benchmark.paths?.some((pattern) => changedPaths.some((path) => pathMatches(path, pattern))) ||
        benchmark.symbols?.some((symbol) => touchedSymbols.has(symbol)));
      const touchedHot = this.options.config.performance.hotSymbols.filter((symbol) => touchedSymbols.has(symbol));
      for (const symbol of touchedHot) {
        if (!benchmarkMappings.some((benchmark) => benchmark.symbols?.includes(symbol))) throw new Error(`benchmark_not_configured_for_hot_path:${symbol}`);
      }
      for (const benchmark of benchmarkMappings) {
        for (let index = 0; index < (benchmark.warmup ?? 1); index++) {
          const baseline = await runMappedCommand(this.options.runner, remapArgv(benchmark.argv, this.options.root, baselineWorkspace), baselineWorkspace, benchmark.timeoutMs, signal);
          const next = await runMappedCommand(this.options.runner, remapArgv(benchmark.argv, this.options.root, workspace), workspace, benchmark.timeoutMs, signal);
          if (baseline.code !== 0 || next.code !== 0) throw new Error(`benchmark_failed:${benchmark.id}`);
        }
        const baselineSamples: number[] = [];
        const candidateSamples: number[] = [];
        for (let index = 0; index < (benchmark.samples ?? 5); index++) {
          const baseline = await runMappedCommand(this.options.runner, remapArgv(benchmark.argv, this.options.root, baselineWorkspace), baselineWorkspace, benchmark.timeoutMs, signal);
          const next = await runMappedCommand(this.options.runner, remapArgv(benchmark.argv, this.options.root, workspace), workspace, benchmark.timeoutMs, signal);
          if (baseline.code !== 0 || next.code !== 0) throw new Error(`benchmark_failed:${benchmark.id}`);
          baselineSamples.push(baseline.durationMs);
          candidateSamples.push(next.durationMs);
        }
        const baselineMedian = median(baselineSamples);
        const candidateMedian = median(candidateSamples);
        const regression = baselineMedian <= 0 ? 0 : (candidateMedian / baselineMedian - 1) * 100;
        const pass = regression <= this.options.config.performance.maxRegressionPercent;
        checks.push({
          id: `benchmark:${benchmark.id}`,
          status: pass ? "pass" : "fail",
          durationMs: candidateMedian,
          diagnostics: [`baseline_median_ms=${baselineMedian.toFixed(3)}`, `candidate_median_ms=${candidateMedian.toFixed(3)}`, `regression_percent=${regression.toFixed(3)}`],
        });
        if (!pass) throw new Error(`performance_regression:${benchmark.id}`);
      }
      return { checks, workspace, baselineWorkspace, benchmarksRun: benchmarkMappings.length };
    } catch (error) {
      await Promise.all([
        rm(workspace, { recursive: true, force: true }),
        rm(baselineWorkspace, { recursive: true, force: true }),
      ]);
      throw error;
    }
  }

  private async commit(candidates: Candidate[], generation: number, headerRootHash: string): Promise<Record<string, string>> {
    this.assertGeneration(generation);
      if (await hashHeaders(this.options.root) !== headerRootHash) throw new Error("header_changed");
      for (const candidate of candidates) if (await hashFile(candidate.absolutePath) !== candidate.originalHash) throw new Error("source_race");
      const committed: Candidate[] = [];
      try {
        for (let index = 0; index < candidates.length; index++) {
          const candidate = candidates[index]!;
          this.assertGeneration(generation);
          if (await hashHeaders(this.options.root) !== headerRootHash) throw new Error("header_changed");
          for (let remaining = index; remaining < candidates.length; remaining++) {
            const pending = candidates[remaining]!;
            if (await hashFile(pending.absolutePath) !== pending.originalHash) throw new Error("source_race");
          }
          const mode = (await stat(candidate.absolutePath)).mode;
          await atomicWrite(candidate.absolutePath, candidate.candidate, mode & 0o777);
          committed.push(candidate);
        }
        this.assertGeneration(generation);
        if (await hashHeaders(this.options.root) !== headerRootHash) throw new Error("header_changed");
        for (const candidate of candidates) if (await hashFile(candidate.absolutePath) !== candidate.candidateHash) throw new Error("post_commit_source_race");
      } catch (error) {
        const failures: string[] = [];
        for (const candidate of [...committed].reverse()) {
          try {
            if (await hashFile(candidate.absolutePath).catch(() => "") !== candidate.candidateHash) {
              failures.push(`${candidate.path}:conflict`);
              continue;
            }
            await atomicWrite(candidate.absolutePath, candidate.original, (await stat(candidate.absolutePath)).mode & 0o777);
            if (await hashFile(candidate.absolutePath) !== candidate.originalHash) failures.push(`${candidate.path}:verify`);
          } catch (rollbackError) {
            failures.push(`${candidate.path}:${(rollbackError as Error).message}`);
          }
        }
        if (failures.length) throw new Error(`rollback_conflict:${failures.join(",")}`, { cause: error });
        throw error;
      }
      const hashes: Record<string, string> = {};
      for (const candidate of candidates) {
        hashes[candidate.path] = candidate.candidateHash;
        this.options.onCommit?.(candidate.path, candidate.candidateHash);
      }
      this.options.clang.clearCache();
      return hashes;
  }

  async apply(input: { generation: number; headerRootHash: string; changes: FileChange[]; evidence: Evidence[] }, signal?: AbortSignal): Promise<ApplyResult> {
    return this.exclusive(() => this.queuePaths(input.changes.map((change) => change.path), async () => {
      const diagnostics: string[] = [];
      let workspace: string | undefined;
      let baselineWorkspace: string | undefined;
      try {
        this.assertGeneration(input.generation);
        await this.verifyEvidence(input.evidence);
        if (await hashHeaders(this.options.root) !== input.headerRootHash) throw new Error("header_changed");
        const candidates = await this.prepare(input.changes);
        const verification = await this.verifyCandidates(candidates, input.evidence, signal);
        workspace = verification.workspace;
        baselineWorkspace = verification.baselineWorkspace;
        this.assertGeneration(input.generation);
        const hashes = await this.commit(candidates, input.generation, input.headerRootHash);
        return {
          status: "changed", changed: candidates.map((item) => item.path), checks: verification.checks, diagnostics,
          performance: verification.benchmarksRun === 0
            ? { status: "unverified", reason: "benchmark_not_configured" } : { status: "pass" },
          hashes,
        };
      } catch (error) {
        diagnostics.push((error as Error).message);
        return { status: "rejected", changed: [], checks: [], diagnostics, performance: { status: "unverified", reason: "candidate_rejected" }, hashes: {} };
      } finally {
        await Promise.all([
          ...(workspace ? [rm(workspace, { recursive: true, force: true })] : []),
          ...(baselineWorkspace ? [rm(baselineWorkspace, { recursive: true, force: true })] : []),
        ]);
      }
    }));
  }

  async todo(input: { generation: number; headerRootHash?: string; changes: TodoChange[] }): Promise<ApplyResult> {
    return this.exclusive(() => this.queuePaths(input.changes.map((change) => change.path), async () => {
      try {
        this.assertGeneration(input.generation);
        if (input.headerRootHash !== undefined && await hashHeaders(this.options.root) !== input.headerRootHash) throw new Error("header_changed");
        const candidates: Candidate[] = [];
        for (const change of input.changes) {
          const source = await resolveExistingSource(this.options.root, change.path);
          if (source.sha256 !== change.expectedSha256) throw new Error("stale_source");
          for (const insertion of change.insertions) validateTechnicalComment(insertion.comment);
          const inserted = insertTechnicalComments(source.content, change.insertions);
          candidates.push({
            path: source.relativePath, absolutePath: source.absolutePath, original: source.content, originalHash: source.sha256,
            candidate: inserted.content, candidateHash: sha256(inserted.content), ranges: [],
          });
        }
        candidates.sort((a, b) => a.absolutePath.localeCompare(b.absolutePath));
        const headerRootHash = input.headerRootHash ?? await hashHeaders(this.options.root);
        const hashes = await this.commit(candidates, input.generation, headerRootHash);
        return { status: "todo", changed: candidates.map((item) => item.path), checks: [], diagnostics: [], performance: { status: "unverified", reason: "todo_only" }, hashes };
      } catch (error) {
        return { status: "rejected", changed: [], checks: [], diagnostics: [(error as Error).message], performance: { status: "unverified", reason: "todo_rejected" }, hashes: {} };
      }
    }));
  }

  async check(input: { generation: number; translationUnits: string[]; checks: Array<"compile" | "configured-tests"> }, signal?: AbortSignal): Promise<CheckRecord[]> {
    this.assertGeneration(input.generation);
    const results: CheckRecord[] = [];
    const paths: string[] = [];
    for (const unit of input.translationUnits) {
      const source = await resolveExistingSource(this.options.root, unit);
      paths.push(source.relativePath);
      if (input.checks.includes("compile")) {
        try {
          const contract = await this.options.clang.contract(source.relativePath, signal);
          const count = countDiagnostics(contract.diagnostics);
          results.push({ id: `compile:${source.relativePath}`, status: count.errors === 0 ? "pass" : "fail", diagnostics: contract.diagnostics.map((item) => `${item.severity}:${item.message}`) });
        } catch (error) {
          results.push({ id: `compile:${source.relativePath}`, status: "fail", diagnostics: [(error as Error).message] });
        }
      }
    }
    if (input.checks.includes("configured-tests")) {
      const tests = mappedTests(this.options.config, paths);
      if (tests.length > 0) {
        const workspace = await copyWorkspace(this.options.root);
        try {
          for (const test of tests) {
            const result = await runMappedCommand(this.options.runner, remapArgv(test.argv, this.options.root, workspace), workspace, test.timeoutMs, signal);
            results.push({ id: `test:${test.id}`, status: result.code === 0 ? "pass" : "fail", diagnostics: result.stderr ? [result.stderr] : [], durationMs: result.durationMs });
          }
        } finally {
          await rm(workspace, { recursive: true, force: true });
        }
      }
    }
    return results;
  }
}
