import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

export interface CommandSpec {
  argv: [string, ...string[]];
  timeoutMs?: number;
}

export interface TestMapping extends CommandSpec {
  id: string;
  paths: string[];
}

export interface BenchmarkMapping extends CommandSpec {
  id: string;
  paths?: string[];
  symbols?: string[];
  warmup?: number;
  samples?: number;
}

export interface PiFeConfig {
  enabled: boolean;
  compileCommands: string;
  watch: {
    debounceMs: number;
    include: string[];
    exclude: string[];
  };
  verification: {
    tests: TestMapping[];
    benchmarks: BenchmarkMapping[];
  };
  performance: {
    hotSymbols: string[];
    maxRegressionPercent: number;
  };
}

export const DEFAULT_CONFIG: PiFeConfig = {
  enabled: true,
  compileCommands: "build/compile_commands.json",
  watch: {
    debounceMs: 250,
    include: ["**/*"],
    exclude: [
      ".git/**",
      "**/node_modules/**",
      "**/build/**",
      "**/out/**",
      "**/dist/**",
      "**/vendor/**",
      "**/generated/**",
      "**/.cache/**",
      "**/*.swp",
      "**/*.swo",
      "**/*.swap",
      "*.swap",
      ".*.swap",
      "**/*~",
      "**/.#*",
      "**/*.tmp",
    ],
  },
  verification: { tests: [], benchmarks: [] },
  performance: { hotSymbols: [], maxRegressionPercent: 0 },
};

function commandSpec(value: unknown, label: string): asserts value is CommandSpec {
  if (typeof value !== "object" || value === null) throw new Error(`${label} must be an object`);
  const argv = (value as { argv?: unknown }).argv;
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((part) => typeof part !== "string" || part.length === 0)) {
    throw new Error(`${label}.argv must be a non-empty string array`);
  }
  const executable = argv[0] as string;
  if (/^(?:ba|z|c|k|fi)?sh(?:\.exe)?$/i.test(executable.split(/[\\/]/).at(-1) ?? "") || /^(?:cmd|powershell|pwsh)(?:\.exe)?$/i.test(executable.split(/[\\/]/).at(-1) ?? "")) {
    throw new Error(`${label}.argv raw shell executables are denied`);
  }
  const timeoutMs = (value as { timeoutMs?: unknown }).timeoutMs;
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || (timeoutMs as number) <= 0)) {
    throw new Error(`${label}.timeoutMs must be a positive integer`);
  }
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be a string array`);
  }
  return [...value];
}

/** Parse trusted configuration. Unknown keys are ignored, but every accepted value is validated. */
export function parseConfig(raw: unknown): PiFeConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("pi-fe config must be an object");
  const input = raw as Record<string, unknown>;
  const watch = typeof input.watch === "object" && input.watch !== null ? input.watch as Record<string, unknown> : {};
  const verification = typeof input.verification === "object" && input.verification !== null
    ? input.verification as Record<string, unknown> : {};
  const performance = typeof input.performance === "object" && input.performance !== null
    ? input.performance as Record<string, unknown> : {};

  const testsRaw = verification.tests ?? DEFAULT_CONFIG.verification.tests;
  if (!Array.isArray(testsRaw)) throw new Error("verification.tests must be an array");
  const tests = testsRaw.map((item, index): TestMapping => {
    commandSpec(item, `verification.tests[${index}]`);
    const entry = item as unknown as Record<string, unknown>;
    if (typeof entry.id !== "string" || entry.id.length === 0) throw new Error(`verification.tests[${index}].id is required`);
    const paths = stringArray(entry.paths, `verification.tests[${index}].paths`);
    return { id: entry.id, paths, argv: [...item.argv] as [string, ...string[]], ...(item.timeoutMs ? { timeoutMs: item.timeoutMs } : {}) };
  });

  const benchmarksRaw = verification.benchmarks ?? DEFAULT_CONFIG.verification.benchmarks;
  if (!Array.isArray(benchmarksRaw)) throw new Error("verification.benchmarks must be an array");
  const benchmarks = benchmarksRaw.map((item, index): BenchmarkMapping => {
    commandSpec(item, `verification.benchmarks[${index}]`);
    const entry = item as unknown as Record<string, unknown>;
    if (typeof entry.id !== "string" || entry.id.length === 0) throw new Error(`verification.benchmarks[${index}].id is required`);
    const warmup = entry.warmup ?? 1;
    const samples = entry.samples ?? 5;
    if (!Number.isInteger(warmup) || (warmup as number) < 0 || !Number.isInteger(samples) || (samples as number) < 1) {
      throw new Error(`verification.benchmarks[${index}] warmup/samples are invalid`);
    }
    return {
      id: entry.id,
      argv: [...item.argv] as [string, ...string[]],
      ...(entry.paths === undefined ? {} : { paths: stringArray(entry.paths, `verification.benchmarks[${index}].paths`) }),
      ...(entry.symbols === undefined ? {} : { symbols: stringArray(entry.symbols, `verification.benchmarks[${index}].symbols`) }),
      warmup: warmup as number,
      samples: samples as number,
      ...(item.timeoutMs ? { timeoutMs: item.timeoutMs } : {}),
    };
  });

  const debounceMs = watch.debounceMs ?? DEFAULT_CONFIG.watch.debounceMs;
  const maxRegressionPercent = performance.maxRegressionPercent ?? DEFAULT_CONFIG.performance.maxRegressionPercent;
  if (!Number.isInteger(debounceMs) || (debounceMs as number) < 0) throw new Error("watch.debounceMs must be a non-negative integer");
  if (typeof maxRegressionPercent !== "number" || !Number.isFinite(maxRegressionPercent) || maxRegressionPercent < 0) {
    throw new Error("performance.maxRegressionPercent must be a non-negative number");
  }
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new Error("enabled must be boolean");
  if (input.compileCommands !== undefined && (typeof input.compileCommands !== "string" || input.compileCommands.length === 0)) {
    throw new Error("compileCommands must be a non-empty string");
  }

  return {
    enabled: input.enabled as boolean | undefined ?? DEFAULT_CONFIG.enabled,
    compileCommands: input.compileCommands as string | undefined ?? DEFAULT_CONFIG.compileCommands,
    watch: {
      debounceMs: debounceMs as number,
      include: watch.include === undefined ? [...DEFAULT_CONFIG.watch.include] : stringArray(watch.include, "watch.include"),
      exclude: watch.exclude === undefined ? [...DEFAULT_CONFIG.watch.exclude] : stringArray(watch.exclude, "watch.exclude"),
    },
    verification: { tests, benchmarks },
    performance: {
      hotSymbols: performance.hotSymbols === undefined
        ? [...DEFAULT_CONFIG.performance.hotSymbols]
        : stringArray(performance.hotSymbols, "performance.hotSymbols"),
      maxRegressionPercent,
    },
  };
}

/** Load optional configuration without creating a file. Only call this for a trusted project. */
export async function loadConfig(root: string): Promise<{ config: PiFeConfig; path?: string }> {
  const candidates = [resolve(root, ".pi", "pi-fe.json"), resolve(root, ".pi-fe.json")];
  for (const path of candidates) {
    try {
      const config = parseConfig(JSON.parse(await readFile(path, "utf8")));
      return { config, path };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error(`Invalid pi-fe configuration at ${path}: ${(error as Error).message}`);
    }
  }
  return { config: parseConfig({}) };
}

export function resolveConfigPath(root: string, configuredPath: string): string {
  return isAbsolute(configuredPath) ? configuredPath : resolve(root, configuredPath);
}
