import { StringEnum } from "@earendil-works/pi-ai";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { ClangEngine } from "./clang.js";
import type { ApplyResult, TransactionEngine } from "./transaction.js";

const Generation = Type.Integer({ minimum: 0 });
const PathString = Type.String({ minLength: 1, maxLength: 512 });
const Sha256 = Type.String({ pattern: "^[a-f0-9]{64}$" });

export const ContractSchema = Type.Object({
  paths: Type.Array(PathString, { minItems: 1 }),
  symbols: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  generation: Generation,
}, { additionalProperties: false });

export const CheckSchema = Type.Object({
  generation: Generation,
  translationUnits: Type.Array(PathString, { minItems: 1 }),
  checks: Type.Array(StringEnum(["compile", "configured-tests"] as const), { minItems: 1, uniqueItems: true }),
}, { additionalProperties: false });

const EvidenceSchema = Type.Object({
  kind: Type.String({ minLength: 1 }),
  path: PathString,
  line: Type.Optional(Type.Integer({ minimum: 1 })),
  sha256: Sha256,
  symbol: Type.Optional(Type.String({ minLength: 1 })),
  constraint: Type.Optional(Type.String({ minLength: 1 })),
}, { additionalProperties: false });

export const ApplySchema = Type.Object({
  generation: Generation,
  headerRootHash: Sha256,
  changes: Type.Array(Type.Object({
    path: PathString,
    expectedSha256: Sha256,
    edits: Type.Array(Type.Object({ oldText: Type.String({ minLength: 1 }), newText: Type.String() }, { additionalProperties: false }), { minItems: 1 }),
  }, { additionalProperties: false }), { minItems: 1 }),
  evidence: Type.Array(EvidenceSchema, { minItems: 1 }),
}, { additionalProperties: false });

export const TodoSchema = Type.Object({
  generation: Generation,
  headerRootHash: Type.Optional(Sha256),
  changes: Type.Array(Type.Object({
    path: PathString,
    expectedSha256: Sha256,
    insertions: Type.Array(Type.Object({
      line: Type.Integer({ minimum: 1 }),
      comment: Type.String({ pattern: "^//@(TODO|NOTE): [^\\r\\n]+$" }),
    }, { additionalProperties: false }), { minItems: 1 }),
  }, { additionalProperties: false }), { minItems: 1 }),
}, { additionalProperties: false });

const CheckRecordSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 256 }),
  status: StringEnum(["pass", "fail", "baseline-fail", "skipped"] as const),
}, { additionalProperties: false });

export const FinalizeSchema = Type.Object({
  generation: Generation,
  status: StringEnum(["changed", "unchanged", "todo", "rejected", "failed"] as const),
  changed: Type.Array(PathString, { maxItems: 16 }),
  checks: Type.Array(CheckRecordSchema, { maxItems: 32 }),
  todos: Type.Array(Type.String({ maxLength: 256 }), { maxItems: 16 }),
  diagnostics: Type.Array(Type.String({ maxLength: 256 }), { maxItems: 16 }),
}, { additionalProperties: false });

export type ContractInput = Static<typeof ContractSchema>;
export type CheckInput = Static<typeof CheckSchema>;
export type ApplyInput = Static<typeof ApplySchema>;
export type TodoInput = Static<typeof TodoSchema>;
export type FinalizeInput = Static<typeof FinalizeSchema>;

export interface ToolController {
  clang: ClangEngine;
  transaction: TransactionEngine;
  generation: () => number;
  noteMutation: (result: ApplyResult, todos?: string[]) => void;
  noteChecks: (checks: ApplyResult["checks"]) => void;
  noteFailure: (diagnostic: string) => void;
  finalize: (result: FinalizeInput) => void;
}

function jsonResult(value: unknown, terminate = false) {
  const json = JSON.stringify(value);
  const truncated = truncateHead(json, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
  const text = truncated.truncated
    ? `${truncated.content}\n[truncated bytes=${truncated.outputBytes}/${truncated.totalBytes} lines=${truncated.outputLines}/${truncated.totalLines}]`
    : truncated.content;
  return { content: [{ type: "text" as const, text }], details: value, ...(terminate ? { terminate: true } : {}) };
}

function requireGeneration(expected: number, actual: number): void {
  if (expected !== actual) throw new Error(`stale_input:expected_generation=${actual}`);
}

export function registerTools(pi: ExtensionAPI, controller: ToolController): void {
  pi.registerTool({
    name: "cxx_contract",
    label: "C/C++ contract",
    description: `Extract declaration, definition, body-range, reference, and compile-command evidence with Clang. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES} bytes.`,
    promptSnippet: "Extract exact Clang-backed C/C++ contract evidence before proposing an implementation",
    promptGuidelines: ["Use cxx_contract before cxx_apply; fail closed and use cxx_todo when AST or declaration mapping is uncertain."],
    parameters: ContractSchema,
    async execute(_id, params, signal) {
      try {
        requireGeneration(params.generation, controller.generation());
        const requestedSymbols = new Set(params.symbols ?? []);
        const units = [];
        for (const path of [...new Set(params.paths)]) {
          const contract = await controller.clang.contract(path, signal);
        const keep = <T extends { qualifiedName?: string; name?: string }>(values: T[]): T[] => requestedSymbols.size === 0
          ? values : values.filter((value) => requestedSymbols.has(value.qualifiedName ?? "") || requestedSymbols.has(value.name ?? ""));
          units.push({
            path,
            declarations: keep(contract.declarations),
          definitions: keep(contract.definitions),
          bodyRanges: contract.bodyRanges,
          references: contract.references,
          compileCommand: {
            databasePath: contract.compileCommand.databasePath,
            directory: contract.compileCommand.directory,
            file: contract.compileCommand.file,
            executable: contract.compileCommand.executable,
            arguments: contract.compileCommand.arguments,
            hash: contract.compileCommand.hash,
          },
          headerRootHash: contract.headerRootHash,
            diagnostics: contract.diagnostics,
          });
        }
        const hashes = new Set(units.map((unit) => unit.headerRootHash));
        if (hashes.size !== 1) throw new Error("contract_header_generation_conflict");
        return jsonResult({ generation: params.generation, units, headerRootHash: units[0]!.headerRootHash });
      } catch (error) {
        controller.noteFailure((error as Error).message);
        throw error;
      }
    },
  });

  pi.registerTool({
    name: "cxx_check",
    label: "C/C++ check",
    description: "Run only configured, argv-based compile and mapped test checks against the current tree.",
    promptSnippet: "Verify current C/C++ translation units without mutation",
    parameters: CheckSchema,
    async execute(_id, params, signal) {
      try {
        const checks = await controller.transaction.check(params, signal);
        controller.noteChecks(checks);
        return jsonResult({ generation: params.generation, checks });
      } catch (error) {
        controller.noteFailure((error as Error).message);
        throw error;
      }
    },
  });

  pi.registerTool({
    name: "cxx_apply",
    label: "C/C++ apply",
    description: "Apply exact replacements to existing .c/.cpp files only after Clang structural and differential verification. Never creates source files or edits headers.",
    promptSnippet: "Atomically apply a contract-backed C/C++ implementation candidate",
    promptGuidelines: [
      "Use cxx_apply as the sole semantic mutation path; include current generation, exact source/header hashes, and structured evidence.",
      "Never use cxx_apply for declarations, signatures, global state, helper types, speculative behavior, or unrelated formatting.",
    ],
    parameters: ApplySchema,
    async execute(_id, params, signal) {
      const result = await controller.transaction.apply(params, signal);
      controller.noteMutation(result);
      return jsonResult(result);
    },
  });

  pi.registerTool({
    name: "cxx_todo",
    label: "C/C++ TODO",
    description: "Insert grammar-checked //@TODO: or //@NOTE: lines into existing .c/.cpp files only. No code tokens or declarations are accepted.",
    promptSnippet: "Record ambiguity without speculative implementation",
    promptGuidelines: ["Use cxx_todo whenever behavior, destination, compiler context, or header compatibility is ambiguous."],
    parameters: TodoSchema,
    async execute(_id, params) {
      const result = await controller.transaction.todo(params);
      controller.noteMutation(result, params.changes.flatMap((change) => change.insertions.map((insertion) => insertion.comment)));
      return jsonResult(result);
    },
  });

  pi.registerTool({
    name: "cxx_finalize",
    label: "C/C++ finalize",
    description: "Emit the sole final structured result and terminate the run.",
    promptSnippet: "Finalize every strict C/C++ analysis run with compact structured status",
    promptGuidelines: ["Call cxx_finalize exactly once as the final tool in every MODE=CXX_IMPL_STRICT run."],
    parameters: FinalizeSchema,
    async execute(_id, params) {
      requireGeneration(params.generation, controller.generation());
      controller.finalize(params);
      return jsonResult(params, true);
    },
  });
}
