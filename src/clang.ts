import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { access, readFile, readdir, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { HEADER_SUFFIXES, SOURCE_SUFFIXES, hashHeaders, isContained, normalizeRelativePath, sha256 } from "./policy.js";

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
  killed?: boolean;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; signal?: AbortSignal; timeout?: number },
) => Promise<CommandResult>;

export interface CompileDatabaseEntry {
  directory: string;
  file: string;
  arguments?: string[];
  command?: string;
  output?: string;
}

export interface CompileCommand {
  databasePath: string;
  directory: string;
  file: string;
  executable: string;
  arguments: string[];
  hash: string;
}

export interface SourceRange {
  path: string;
  start: number;
  end: number;
  startLine?: number;
  endLine?: number;
  symbol?: string;
  symbolKey?: string;
}

export interface AstDeclaration {
  id: string;
  kind: string;
  name: string;
  qualifiedName: string;
  signature: string;
  mangledName?: string;
  path: string;
  line?: number;
  external: boolean;
  definition: boolean;
  template?: boolean;
  sourceRange?: SourceRange;
}

export interface AstReference {
  kind: string;
  name: string;
  targetId?: string;
  path: string;
  line?: number;
}

export interface FunctionMetrics {
  symbol: string;
  allocation: number;
  containerGrowth: number;
  stringConstruction: number;
  nonTrivialCopy: number;
  lock: number;
  atomic: number;
  exception: number;
  rtti: number;
  virtualDispatch: number;
  loop: number;
  branch: number;
  systemCall: number;
  logging: number;
}

export interface AstAnalysis {
  declarations: AstDeclaration[];
  definitions: AstDeclaration[];
  bodyRanges: SourceRange[];
  references: AstReference[];
  forbiddenSurface: string[];
  exportedSymbols: string[];
  metrics: FunctionMetrics[];
  headerPaths: string[];
  diagnostics: Diagnostic[];
  raw?: unknown;
}

export interface ContractResult extends AstAnalysis {
  compileCommand: CompileCommand;
  headerRootHash: string;
}

export interface Diagnostic {
  path?: string;
  line?: number;
  column?: number;
  severity: "error" | "warning" | "note" | "unknown";
  message: string;
}

export class ClangUnavailableError extends Error {}
export class CompileDatabaseError extends Error {}

const DECL_KINDS = new Set(["FunctionDecl", "CXXMethodDecl", "CXXConstructorDecl", "CXXDestructorDecl", "CXXConversionDecl"]);
const FORBIDDEN_KINDS = new Set([
  "RecordDecl", "CXXRecordDecl", "EnumDecl", "FieldDecl", "TypedefDecl", "TypeAliasDecl", "ClassTemplateDecl",
  "FunctionTemplateDecl", "TypeAliasTemplateDecl", "ConceptDecl", "NamespaceDecl", "AccessSpecDecl",
]);
const EXTERNAL_LINKAGE = new Set(["external", "visible_none"]);

interface AstNode {
  id?: string;
  kind?: string;
  name?: string;
  qualifiedName?: string;
  mangledName?: string;
  type?: { qualType?: string };
  storageClass?: string;
  linkage?: string;
  isImplicit?: boolean;
  completeDefinition?: boolean;
  virtual?: boolean;
  loc?: Location;
  range?: { begin?: Location; end?: Location };
  referencedDecl?: { id?: string; name?: string; kind?: string };
  inner?: AstNode[];
  [key: string]: unknown;
}

interface Location {
  file?: string;
  line?: number;
  col?: number;
  offset?: number;
  tokLen?: number;
  spellingLoc?: Location;
  expansionLoc?: Location;
}

function location(value: Location | undefined): Location | undefined {
  if (!value) return undefined;
  return location(value.expansionLoc) ?? location(value.spellingLoc) ?? value;
}

function posixSplit(command: string): string[] {
  const output: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let active = false;
  for (const character of command) {
    if (escaped) { token += character; escaped = false; active = true; continue; }
    if (character === "\\" && quote !== "'") { escaped = true; active = true; continue; }
    if (quote) {
      if (character === quote) quote = undefined;
      else token += character;
      active = true;
      continue;
    }
    if (character === "'" || character === '"') { quote = character; active = true; continue; }
    if (/\s/.test(character)) {
      if (active) { output.push(token); token = ""; active = false; }
      continue;
    }
    if (/[;&|`$<>\n\r]/.test(character)) throw new CompileDatabaseError("unsafe_compile_command_syntax");
    token += character;
    active = true;
  }
  if (quote || escaped) throw new CompileDatabaseError("invalid_compile_command_quoting");
  if (active) output.push(token);
  return output;
}

async function exists(path: string): Promise<boolean> {
  return access(path, constants.R_OK).then(() => true, () => false);
}

async function findCompileDatabases(root: string): Promise<string[]> {
  const output: string[] = [];
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > 5) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "vendor") continue;
      const path = resolve(directory, entry.name);
      if (entry.isFile() && entry.name === "compile_commands.json") output.push(path);
      else if (entry.isDirectory()) await walk(path, depth + 1);
    }
  };
  await walk(root, 0);
  return output.sort();
}

export async function discoverCompileDatabase(root: string, configured?: string): Promise<string> {
  const canonicalRoot = await realpath(root);
  const configuredPath = configured ? resolve(canonicalRoot, configured) : undefined;
  const found = await findCompileDatabases(canonicalRoot);
  if (configuredPath && await exists(configuredPath)) {
    const canonical = await realpath(configuredPath);
    if (!isContained(canonicalRoot, canonical)) throw new CompileDatabaseError("compile_database_outside_repository");
    if (found.some((path) => resolve(path) !== canonical)) throw new CompileDatabaseError("multiple_compile_databases");
    return canonical;
  }
  if (found.length === 0) throw new CompileDatabaseError("compile_database_unavailable");
  if (found.length > 1) throw new CompileDatabaseError("multiple_compile_databases");
  return await realpath(found[0]!);
}

export async function loadCompileCommand(root: string, translationUnit: string, configured?: string): Promise<CompileCommand> {
  const databasePath = await discoverCompileDatabase(root, configured);
  let entries: unknown;
  try { entries = JSON.parse(await readFile(databasePath, "utf8")); }
  catch (error) { throw new CompileDatabaseError(`invalid_compile_database:${(error as Error).message}`); }
  if (!Array.isArray(entries)) throw new CompileDatabaseError("compile_database_not_array");
  const source = await realpath(resolve(root, translationUnit));
  const matches = (entries as CompileDatabaseEntry[]).filter((entry) => {
    if (!entry || typeof entry.directory !== "string" || typeof entry.file !== "string") return false;
    return resolve(entry.directory, entry.file) === source;
  });
  if (matches.length !== 1) throw new CompileDatabaseError(matches.length === 0 ? "compile_command_unavailable" : "ambiguous_compile_command");
  const entry = matches[0]!;
  const argv = entry.arguments ? [...entry.arguments] : typeof entry.command === "string" ? posixSplit(entry.command) : [];
  if (argv.length === 0 || argv.some((item) => typeof item !== "string")) throw new CompileDatabaseError("invalid_compile_command");
  const requestedExecutable = argv.shift()!;
  if (!/^clang(?:\+\+)?(?:-[0-9.]+)?$/.test(basename(requestedExecutable))) throw new ClangUnavailableError("clang_required");
  const executableCandidates = requestedExecutable.includes("/")
    ? [resolve(entry.directory, requestedExecutable)]
    : (process.env.PATH ?? "").split(":").map((directory) => resolve(directory, requestedExecutable));
  let executable: string | undefined;
  for (const candidate of executableCandidates) {
    try { executable = await realpath(candidate); break; } catch { /* continue */ }
  }
  if (!executable) throw new ClangUnavailableError("clang_executable_unavailable");
  if (isContained(await realpath(root), executable)) throw new ClangUnavailableError("project_clang_executable_denied");
  const trustedRoots = ["/usr/bin", "/usr/sbin", "/usr/local/bin", "/opt/homebrew/bin", "/home/linuxbrew/.linuxbrew/bin", "/nix/store"];
  if (!trustedRoots.some((directory) => isContained(directory, executable))) throw new ClangUnavailableError("untrusted_clang_executable");
  const executableInfo = await stat(executable);
  if (!executableInfo.isFile() || (executableInfo.mode & 0o022) !== 0) throw new ClangUnavailableError("writable_clang_executable_denied");
  const deniedFlags = /^(?:@|-MJ|-save-temps|--save-temps|-fplugin|-fpass-plugin|-fprofile|-fcoverage|--coverage|-ftime-trace|-fmodules(?:=.*)?|-fimplicit-modules|-fimplicit-module-maps|-fmodules-cache-path|-serialize-diagnostics|--serialize-diagnostics|-Xclang$)/;
  if (argv.some((arg) => deniedFlags.test(arg))) throw new CompileDatabaseError("side_effecting_compile_flag_denied");
  const canonicalDirectory = await realpath(entry.directory);
  if (!isContained(await realpath(root), source)) throw new CompileDatabaseError("translation_unit_outside_repository");
  return {
    databasePath,
    directory: canonicalDirectory,
    file: source,
    executable,
    arguments: argv,
    hash: sha256(JSON.stringify([canonicalDirectory, source, executable, argv])),
  };
}

function analysisArguments(command: CompileCommand, target: string): string[] {
  const result: string[] = [];
  const source = resolve(command.file);
  const takesValue = new Set(["-o", "-MF", "-MT", "-MQ", "--serialize-diagnostics"]);
  for (let index = 0; index < command.arguments.length; index++) {
    const arg = command.arguments[index]!;
    if (takesValue.has(arg)) { index++; continue; }
    if (["-c", "-MD", "-MMD", "-MP", "-MG"].includes(arg)) continue;
    if (arg.startsWith("-o") && arg.length > 2) continue;
    if (resolve(command.directory, arg) === source) continue;
    result.push(arg);
  }
  return [...result, "-fsyntax-only", "-fno-color-diagnostics", "-Xclang", "-ast-dump=json", target];
}

function diagnosticList(stderr: string): Diagnostic[] {
  const output: Diagnostic[] = [];
  const pattern = /^(.*?):(\d+):(\d+):\s+(fatal error|error|warning|note):\s+(.*)$/;
  for (const line of stderr.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = line.match(pattern);
    if (!match) { output.push({ severity: "unknown", message: line }); continue; }
    const raw = match[4]!;
    output.push({
      path: match[1]!, line: Number(match[2]), column: Number(match[3]),
      severity: raw.includes("error") ? "error" : raw as "warning" | "note",
      message: match[5]!,
    });
  }
  return output;
}

function nodeFile(node: AstNode, inherited: string): string {
  return location(node.loc)?.file ?? location(node.range?.begin)?.file ?? inherited;
}

function nodeRange(node: AstNode, inheritedPath: string, root: string): SourceRange | undefined {
  const begin = location(node.range?.begin);
  const end = location(node.range?.end);
  if (begin?.offset === undefined || end?.offset === undefined) return undefined;
  const file = begin.file ?? inheritedPath;
  const absolute = resolve(file);
  return {
    path: isContained(root, absolute) ? normalizeRelativePath(relative(root, absolute)) : absolute,
    start: begin.offset,
    end: end.offset + (end.tokLen ?? 1),
    ...(begin.line === undefined ? {} : { startLine: begin.line }),
    ...(end.line === undefined ? {} : { endLine: end.line }),
  };
}

function surfaceFingerprint(node: AstNode, qualifiedName: string): string {
  const enumConstants = node.kind === "EnumDecl"
    ? (node.inner ?? []).filter((child) => child.kind === "EnumConstantDecl").map((child) => ({ name: child.name, value: child.value }))
    : undefined;
  const raw = node as Record<string, unknown>;
  return sha256(JSON.stringify({
    kind: node.kind,
    qualifiedName,
    type: node.type?.qualType,
    storageClass: node.storageClass,
    linkage: node.linkage,
    completeDefinition: node.completeDefinition,
    bases: raw.bases,
    tagUsed: raw.tagUsed,
    access: raw.access,
    virtual: node.virtual,
    enumConstants,
  }));
}

function emptyMetrics(symbol: string): FunctionMetrics {
  return { symbol, allocation: 0, containerGrowth: 0, stringConstruction: 0, nonTrivialCopy: 0, lock: 0, atomic: 0, exception: 0, rtti: 0, virtualDispatch: 0, loop: 0, branch: 0, systemCall: 0, logging: 0 };
}

function metricWalk(node: AstNode, metrics: FunctionMetrics): void {
  const kind = node.kind ?? "";
  const name = `${node.name ?? ""} ${node.referencedDecl?.name ?? ""}`;
  if (kind === "CXXNewExpr") metrics.allocation++;
  if (["ForStmt", "WhileStmt", "DoStmt", "CXXForRangeStmt"].includes(kind)) metrics.loop++;
  if (["IfStmt", "SwitchStmt", "ConditionalOperator"].includes(kind)) metrics.branch++;
  if (["CXXThrowExpr", "CXXTryStmt"].includes(kind)) metrics.exception++;
  if (["CXXDynamicCastExpr", "CXXTypeidExpr"].includes(kind)) metrics.rtti++;
  if (kind === "AtomicExpr" || /atomic/.test(name)) metrics.atomic++;
  if (/\b(push_back|emplace_back|insert|reserve|resize|append)\b/.test(name)) metrics.containerGrowth++;
  if (/\b(basic_string|string)\b/.test(name) && ["CXXConstructExpr", "CXXTemporaryObjectExpr"].includes(kind)) metrics.stringConstruction++;
  if (/\b(mutex|lock|scoped_lock|unique_lock|lock_guard)\b/.test(name)) metrics.lock++;
  if (/\b(printf|fprintf|puts|cerr|cout|clog|syslog|log)\b/.test(name)) metrics.logging++;
  if (/\b(open|close|read|write|socket|send|recv|ioctl|fork|exec)\b/.test(name)) metrics.systemCall++;
  if (kind === "CXXConstructExpr" && typeof node.type?.qualType === "string" && !/\b(int|char|short|long|float|double|bool|void)\b/.test(node.type.qualType)) metrics.nonTrivialCopy++;
  if (kind === "CXXMemberCallExpr" && node.virtual === true) metrics.virtualDispatch++;
  for (const child of node.inner ?? []) metricWalk(child, metrics);
}

export function extractAst(ast: unknown, root: string, mainFile: string): AstAnalysis {
  if (typeof ast !== "object" || ast === null) throw new ClangUnavailableError("invalid_ast_output");
  const canonicalRoot = resolve(root);
  const declarations: AstDeclaration[] = [];
  const definitions: AstDeclaration[] = [];
  const bodyRanges: SourceRange[] = [];
  const bodyRangeDefinitions: AstDeclaration[] = [];
  const references: AstReference[] = [];
  const forbiddenSurface: string[] = [];
  const exportedSymbols = new Set<string>();
  const metrics: FunctionMetrics[] = [];
  const headerPaths = new Set<string>();

  const walk = (node: AstNode, scopes: string[], inheritedFile: string, inTemplate: boolean): void => {
    const kind = node.kind ?? "";
    const file = nodeFile(node, inheritedFile);
    const absoluteFile = isAbsolute(file) ? resolve(file) : resolve(mainFile);
    const path = isContained(canonicalRoot, absoluteFile) ? normalizeRelativePath(relative(canonicalRoot, absoluteFile)) : absoluteFile;
    const name = node.name ?? "";
    const nextScopes = [...scopes];
    if (["NamespaceDecl", "RecordDecl", "CXXRecordDecl", "ClassTemplateDecl"].includes(kind) && name) nextScopes.push(name);
    const qualifiedName = node.qualifiedName ?? [...scopes, name].filter(Boolean).join("::");
    const signature = node.type?.qualType ?? "";
    const body = DECL_KINDS.has(kind) ? (node.inner ?? []).find((child) => child.kind === "CompoundStmt") : undefined;
    const external = Boolean(node.mangledName) || EXTERNAL_LINKAGE.has(node.linkage ?? "") || (DECL_KINDS.has(kind) && node.storageClass !== "static" && !node.isImplicit);

    if (DECL_KINDS.has(kind) && name && !node.isImplicit) {
      const decl: AstDeclaration = {
        id: node.id ?? sha256(`${kind}:${qualifiedName}:${signature}:${path}`), kind, name, qualifiedName, signature,
        ...(node.mangledName ? { mangledName: node.mangledName } : {}), path,
        ...(location(node.loc)?.line === undefined ? {} : { line: location(node.loc)!.line! }),
        external, definition: Boolean(body),
        ...(inTemplate ? { template: true } : {}),
      };
      declarations.push(decl);
      if (body) {
        definitions.push(decl);
        if ((body.range?.begin?.expansionLoc || body.range?.begin?.spellingLoc) && isContained(canonicalRoot, absoluteFile)) {
          throw new ClangUnavailableError(`macro_generated_ast_range:${qualifiedName}`);
        }
        const range = nodeRange(body, file, canonicalRoot);
        const declarationRange = nodeRange(node, file, canonicalRoot);
        if (declarationRange) (decl as AstDeclaration & { sourceRange?: SourceRange }).sourceRange = declarationRange;
        if (range) {
          bodyRanges.push(range);
          bodyRangeDefinitions.push(decl);
        } else if (isContained(canonicalRoot, absoluteFile)) {
          throw new ClangUnavailableError(`unresolvable_ast_range:${qualifiedName}`);
        }
        const counts = emptyMetrics(qualifiedName);
        metricWalk(body, counts);
        metrics.push(counts);
      }
      if (external && node.mangledName) exportedSymbols.add(node.mangledName);
    }

    if (kind === "VarDecl" && (node.storageClass === "static" || node.storageClass === "extern" || scopes.length === 0) && !node.isImplicit) {
      forbiddenSurface.push(`VarDecl:${qualifiedName}:${signature}:${node.storageClass ?? "global"}`);
      if (external && node.mangledName) exportedSymbols.add(node.mangledName);
    }
    if (FORBIDDEN_KINDS.has(kind) && !node.isImplicit && isContained(canonicalRoot, absoluteFile)) {
      forbiddenSurface.push(`${kind}:${qualifiedName}:${surfaceFingerprint(node, qualifiedName)}`);
    }
    if ((kind === "MacroDefinitionRecord" || kind === "MacroExpansion") && isContained(canonicalRoot, absoluteFile)) {
      forbiddenSurface.push(`${kind}:${name}:${path}:${location(node.loc)?.line ?? 0}`);
    }
    if ((kind === "DeclRefExpr" || kind === "MemberExpr") && node.referencedDecl) {
      references.push({ kind, name: node.referencedDecl.name ?? name, ...(node.referencedDecl.id ? { targetId: node.referencedDecl.id } : {}), path, ...(location(node.loc)?.line === undefined ? {} : { line: location(node.loc)!.line! }) });
    }
    if (HEADER_SUFFIXES.has(extname(path).toLowerCase()) && isContained(canonicalRoot, absoluteFile)) headerPaths.add(path);
    const childTemplate = inTemplate || ["FunctionTemplateDecl", "ClassTemplateDecl", "ClassTemplateSpecializationDecl"].includes(kind);
    for (const child of node.inner ?? []) walk(child, nextScopes, file, childTemplate);
  };
  walk(ast as AstNode, [], mainFile, false);
  const qualifiedByMangled = new Map<string, string>();
  for (const declaration of declarations) {
    if (!declaration.mangledName || !declaration.qualifiedName.includes("::")) continue;
    const current = qualifiedByMangled.get(declaration.mangledName);
    if (!current || declaration.qualifiedName.length > current.length) qualifiedByMangled.set(declaration.mangledName, declaration.qualifiedName);
  }
  definitions.forEach((definition, index) => {
    const qualified = definition.mangledName ? qualifiedByMangled.get(definition.mangledName) : undefined;
    if (qualified) {
      definition.qualifiedName = qualified;
      const metric = metrics[index];
      if (metric) metric.symbol = qualified;
    }
  });
  bodyRanges.forEach((range, index) => {
    const definition = bodyRangeDefinitions[index];
    if (definition) {
      range.symbol = definition.qualifiedName;
      range.symbolKey = declarationKey(definition);
    }
  });
  return {
    declarations, definitions, bodyRanges, references,
    forbiddenSurface: forbiddenSurface.sort(), exportedSymbols: [...exportedSymbols].sort(), metrics,
    headerPaths: [...headerPaths].sort(), diagnostics: [], raw: ast,
  };
}

export class ClangEngine {
  private readonly cache = new Map<string, ContractResult>();
  constructor(private readonly root: string, private readonly configuredDatabase: string | undefined, private readonly runner: CommandRunner) {}

  async contract(translationUnit: string, signal?: AbortSignal): Promise<ContractResult> {
    const command = await loadCompileCommand(this.root, translationUnit, this.configuredDatabase);
    const content = await readFile(command.file);
    const headerGeneration = await hashHeaders(this.root);
    const key = sha256(Buffer.concat([content, Buffer.from(command.hash), Buffer.from(headerGeneration)]));
    const cached = this.cache.get(key);
    if (cached) return structuredClone(cached);
    const result = await this.runner(command.executable, analysisArguments(command, command.file), { cwd: command.directory, ...(signal ? { signal } : {}) });
    const diagnostics = diagnosticList(result.stderr);
    if (result.code !== 0) throw new ClangUnavailableError(`ast_unavailable:${JSON.stringify(diagnostics.slice(0, 20))}`);
    let ast: unknown;
    try { ast = JSON.parse(result.stdout); }
    catch (error) { throw new ClangUnavailableError(`ast_json_invalid:${(error as Error).message}`); }
    const extracted = extractAst(ast, await realpath(this.root), command.file);
    extracted.diagnostics = diagnostics;
    const headerRootHash = await hashHeaders(this.root);
    if (headerRootHash !== headerGeneration) throw new ClangUnavailableError("header_changed_during_ast_extraction");
    const contract = { ...extracted, compileCommand: command, headerRootHash };
    this.cache.set(key, contract);
    return structuredClone(contract);
  }

  async analyzeCandidate(
    command: CompileCommand,
    candidatePath: string,
    signal?: AbortSignal,
    analysisRoot = this.root,
  ): Promise<AstAnalysis> {
    const result = await this.runner(command.executable, analysisArguments(command, candidatePath), { cwd: command.directory, ...(signal ? { signal } : {}) });
    const diagnostics = diagnosticList(result.stderr);
    if (result.code !== 0) throw new ClangUnavailableError(`candidate_ast_unavailable:${JSON.stringify(diagnostics.slice(0, 20))}`);
    let ast: unknown;
    try { ast = JSON.parse(result.stdout); }
    catch { throw new ClangUnavailableError("candidate_ast_json_invalid"); }
    const extracted = extractAst(ast, await realpath(analysisRoot), candidatePath);
    extracted.diagnostics = diagnostics;
    return extracted;
  }

  clearCache(): void { this.cache.clear(); }
}

export function countDiagnostics(diagnostics: readonly Diagnostic[]): { errors: number; warnings: number } {
  return {
    errors: diagnostics.filter((item) => item.severity === "error").length,
    warnings: diagnostics.filter((item) => item.severity === "warning").length,
  };
}

export function declarationKey(declaration: Pick<AstDeclaration, "qualifiedName" | "signature" | "mangledName">): string {
  return declaration.mangledName ?? `${declaration.qualifiedName}|${declaration.signature}`;
}
