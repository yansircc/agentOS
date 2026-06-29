import {
  createWorkspaceEnv,
  type WorkspaceEnv,
  type WorkspaceEnvBackend,
  type WorkspaceExecOptions,
  type WorkspaceExecResult,
  type WorkspaceFileStat,
} from "../workspace-env-core";
import { Effect } from "effect";
import {
  checkSignal,
  isInside,
  normalizeAbsolutePath,
  parentDir,
  relativePath,
  textDecoder,
  textEncoder,
  truncateUtf8,
  utf8Bytes,
} from "../workspace-env-core/path-policy";

/**
 * Scripted result for one exact in-memory workspace command.
 *
 * @public
 */
export interface InMemoryWorkspaceExecScript {
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly durationMs?: number;
}

/**
 * Options for `createInMemoryWorkspaceEnv`.
 *
 * @public
 */
export interface CreateInMemoryWorkspaceEnvOptions {
  readonly cwd?: string;
  readonly files?: Readonly<Record<string, string | Uint8Array>>;
  readonly scripts?: Readonly<Record<string, InMemoryWorkspaceExecScript>>;
}

/**
 * Error raised by the deterministic in-memory workspace environment.
 *
 * @public
 */
export class InMemoryWorkspaceEnvError extends Error {
  override readonly name = "InMemoryWorkspaceEnvError";
}

interface InMemoryWorkspaceBackend extends WorkspaceEnvBackend {
  readonly seedFile: (path: string, content: string | Uint8Array) => void;
}

const bytesFor = (content: string | Uint8Array): Uint8Array =>
  content instanceof Uint8Array ? new Uint8Array(content) : textEncoder.encode(content);

const copyBytes = (content: Uint8Array): Uint8Array => new Uint8Array(content);

const childPrefix = (path: string): string => (path === "/" ? "/" : `${path}/`);

const compareCodepoint = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const inMemoryPathLabel = (root: string, path: string): string =>
  path === root ? "." : relativePath(root, path);

const missingPathError = (root: string, path: string): InMemoryWorkspaceEnvError =>
  new InMemoryWorkspaceEnvError(
    `in-memory workspace path not found: ${inMemoryPathLabel(root, path)}`,
  );

const assertInsideRoot = (root: string, path: string): void => {
  if (path !== root && !isInside(root, path)) {
    throw new InMemoryWorkspaceEnvError("in-memory workspace path escaped root");
  }
};

const rejectSymbolicRefs = (options: WorkspaceExecOptions): void => {
  if (options.envRefs !== undefined && Object.keys(options.envRefs).length > 0) {
    throw new InMemoryWorkspaceEnvError("in-memory workspace env cannot resolve symbolic env refs");
  }
  if (options.materialRefs !== undefined && options.materialRefs.length > 0) {
    throw new InMemoryWorkspaceEnvError(
      "in-memory workspace env cannot resolve symbolic material refs",
    );
  }
};

const truncatedOutput = (
  text: string,
  maxOutputBytes: number | undefined,
): { readonly text: string; readonly bytes: number; readonly truncated: boolean } => {
  const bytes = utf8Bytes(text);
  if (maxOutputBytes === undefined) return { text, bytes, truncated: false };
  const truncated = truncateUtf8(text, maxOutputBytes);
  return { text: truncated.text, bytes, truncated: truncated.truncated };
};

const createInMemoryWorkspaceBackend = (
  root: string,
  scripts: Readonly<Record<string, InMemoryWorkspaceExecScript>>,
): InMemoryWorkspaceBackend => {
  const files = new Map<string, Uint8Array>();
  const directories = new Set<string>([root]);

  const assertManagedPath = (path: string): void => {
    assertInsideRoot(root, path);
  };

  const pathExists = (path: string): boolean => files.has(path) || directories.has(path);

  const childPaths = (path: string): ReadonlyArray<string> => {
    const prefix = childPrefix(path);
    return [
      ...[...files.keys()].filter((filePath) => filePath.startsWith(prefix)),
      ...[...directories].filter(
        (directoryPath) => directoryPath !== path && directoryPath.startsWith(prefix),
      ),
    ];
  };

  const addDirectory = (path: string, recursive: boolean): void => {
    assertManagedPath(path);
    if (files.has(path)) {
      throw new InMemoryWorkspaceEnvError(
        `in-memory workspace path is a file: ${inMemoryPathLabel(root, path)}`,
      );
    }
    if (directories.has(path)) return;
    const parent = parentDir(root, path);
    if (!directories.has(parent)) {
      if (!recursive) throw missingPathError(root, parent);
      addDirectory(parent, true);
    }
    directories.add(path);
  };

  const ensureParentDirectory = (path: string): void => {
    const parent = parentDir(root, path);
    if (!directories.has(parent)) throw missingPathError(root, parent);
  };

  const writeResolvedFile = (path: string, content: string | Uint8Array): void => {
    assertManagedPath(path);
    if (directories.has(path)) {
      throw new InMemoryWorkspaceEnvError(
        `in-memory workspace path is a directory: ${inMemoryPathLabel(root, path)}`,
      );
    }
    ensureParentDirectory(path);
    files.set(path, bytesFor(content));
  };

  const removeDirectory = (path: string, recursive: boolean): void => {
    const children = childPaths(path);
    if (children.length > 0 && !recursive) {
      throw new InMemoryWorkspaceEnvError(
        `in-memory workspace directory is not empty: ${inMemoryPathLabel(root, path)}`,
      );
    }
    const filePaths = Array.from(files.keys());
    for (const filePath of filePaths) {
      if (filePath === path || filePath.startsWith(childPrefix(path))) files.delete(filePath);
    }
    const directoryPaths = Array.from(directories);
    for (const directoryPath of directoryPaths) {
      if (
        directoryPath !== root &&
        (directoryPath === path || directoryPath.startsWith(childPrefix(path)))
      ) {
        directories.delete(directoryPath);
      }
    }
    if (path === root) directories.add(root);
  };

  const statFor = (path: string): WorkspaceFileStat => {
    const file = files.get(path);
    if (file !== undefined) return { type: "file", size: file.byteLength, mtimeMs: 0 };
    if (directories.has(path)) return { type: "directory", mtimeMs: 0 };
    throw missingPathError(root, path);
  };

  return {
    seedFile: (path, content) => {
      assertManagedPath(path);
      addDirectory(parentDir(root, path), true);
      writeResolvedFile(path, content);
    },
    readFile: async (path, operationOptions) => {
      checkSignal(operationOptions?.signal);
      assertManagedPath(path);
      const file = files.get(path);
      if (file === undefined) throw missingPathError(root, path);
      return textDecoder.decode(file);
    },
    readFileBuffer: async (path, operationOptions) => {
      checkSignal(operationOptions?.signal);
      assertManagedPath(path);
      const file = files.get(path);
      if (file === undefined) throw missingPathError(root, path);
      return copyBytes(file);
    },
    writeFile: async (path, content, operationOptions) => {
      checkSignal(operationOptions?.signal);
      writeResolvedFile(path, content);
    },
    stat: async (path, operationOptions) => {
      checkSignal(operationOptions?.signal);
      assertManagedPath(path);
      return statFor(path);
    },
    readdir: async (path, operationOptions) => {
      checkSignal(operationOptions?.signal);
      assertManagedPath(path);
      if (!directories.has(path)) throw missingPathError(root, path);
      const prefix = childPrefix(path);
      const entries = new Set<string>();
      for (const filePath of files.keys()) {
        if (!filePath.startsWith(prefix)) continue;
        const [entry] = filePath.slice(prefix.length).split("/");
        if (entry !== undefined && entry.length > 0) entries.add(entry);
      }
      for (const directoryPath of directories) {
        if (directoryPath === path || !directoryPath.startsWith(prefix)) continue;
        const [entry] = directoryPath.slice(prefix.length).split("/");
        if (entry !== undefined && entry.length > 0) entries.add(entry);
      }
      return [...entries].sort(compareCodepoint);
    },
    exists: async (path, operationOptions) => {
      checkSignal(operationOptions?.signal);
      assertManagedPath(path);
      return pathExists(path);
    },
    mkdir: async (path, operationOptions) => {
      checkSignal(operationOptions?.signal);
      addDirectory(path, operationOptions?.recursive === true);
    },
    rm: async (path, operationOptions) => {
      checkSignal(operationOptions?.signal);
      assertManagedPath(path);
      if (!pathExists(path)) {
        if (operationOptions?.force === true) return;
        throw missingPathError(root, path);
      }
      if (files.delete(path)) return;
      removeDirectory(path, operationOptions?.recursive === true);
    },
    exec: async (command, options) => {
      checkSignal(options.signal);
      rejectSymbolicRefs(options);
      const cwd = options.cwd ?? root;
      assertManagedPath(cwd);
      if (!directories.has(cwd)) {
        throw new InMemoryWorkspaceEnvError(
          `in-memory workspace exec cwd is not a directory: ${inMemoryPathLabel(root, cwd)}`,
        );
      }
      const script = scripts[command];
      if (script === undefined) {
        throw new InMemoryWorkspaceEnvError(
          `in-memory workspace exec has no script for command: ${command}`,
        );
      }
      const stdout = truncatedOutput(script.stdout ?? "", options.maxOutputBytes);
      const stderr = truncatedOutput(script.stderr ?? "", options.maxOutputBytes);
      const result: WorkspaceExecResult = {
        exitCode: script.exitCode ?? 0,
        stdout: stdout.text,
        stderr: stderr.text,
        stdoutBytes: stdout.bytes,
        stderrBytes: stderr.bytes,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        durationMs: script.durationMs ?? 0,
      };
      checkSignal(options.signal);
      return result;
    },
  };
};

/**
 * Creates a deterministic in-memory workspace environment for consumer tests.
 *
 * Path confinement is owned by the shared `createWorkspaceEnv` contract. The
 * backend only stores in-memory files and returns exact scripted command
 * results; it does not read host files, host environment variables, or symbolic
 * refs.
 *
 * @public
 */
export const createInMemoryWorkspaceEnv = (
  options: CreateInMemoryWorkspaceEnvOptions = {},
): WorkspaceEnv => {
  const cwd = normalizeAbsolutePath(options.cwd ?? "/workspace");
  const backend = createInMemoryWorkspaceBackend(cwd, options.scripts ?? {});
  const env = createWorkspaceEnv({
    domain: { kind: "workspace", ref: cwd },
    cwd,
    backend,
  });

  for (const [path, content] of Object.entries(options.files ?? {})) {
    backend.seedFile(env.resolvePath(path), content);
  }

  return env;
};

export const EXTERNAL_EFFECT_CONFORMANCE_SCENARIOS = [
  {
    id: "request_before_effect",
    requirement: "caller-owned request evidence is recorded before the provider effect runs",
  },
  {
    id: "duplicate_attempt_reuses_existing",
    requirement:
      "duplicate execution observes an existing attempt instead of duplicating the effect",
  },
  {
    id: "running_replay_uses_caller_request",
    requirement: "running replay reconstructs provider execution from caller-owned request state",
  },
  {
    id: "crash_reconcile_from_projection",
    requirement: "effect crash before terminal settlement can be reconciled from caller projection",
  },
  {
    id: "witness_missing_or_provider_unknown_indeterminate",
    requirement:
      "missing witness or unknown provider state maps to caller-owned indeterminate flow",
  },
  {
    id: "digest_or_contract_mismatch_fails_closed",
    requirement: "digest or contract mismatch fails closed through caller validation",
  },
  {
    id: "provider_evidence_cannot_change_canonical_ref",
    requirement:
      "provider evidence cannot rewrite caller-owned canonical operation or product refs",
  },
] as const;

export type ExternalEffectConformanceScenario =
  (typeof EXTERNAL_EFFECT_CONFORMANCE_SCENARIOS)[number];

export type ExternalEffectConformanceScenarioId = ExternalEffectConformanceScenario["id"];

/**
 * Structured issue produced by an external-effect conformance adapter.
 *
 * @public
 */
export interface ExternalEffectConformanceIssue {
  readonly code: string;
  readonly message: string;
  readonly evidence?: unknown;
}

/**
 * Result for one external-effect conformance scenario.
 *
 * @public
 */
export type ExternalEffectConformanceScenarioResult =
  | {
      readonly scenarioId: ExternalEffectConformanceScenarioId;
      readonly status: "passed";
      readonly summary?: string;
      readonly evidence?: unknown;
    }
  | {
      readonly scenarioId: ExternalEffectConformanceScenarioId;
      readonly status: "failed";
      readonly summary?: string;
      readonly issues: ReadonlyArray<ExternalEffectConformanceIssue>;
      readonly evidence?: unknown;
    };

/**
 * Adapter implemented by a caller-specific external-effect system.
 *
 * The adapter owns all event, request, witness, provider, receipt, and product
 * vocabulary. The testing helper only supplies the scenario contract and folds
 * adapter output into a structured report.
 *
 * @public
 */
export interface ExternalEffectConformanceAdapter<E = never, R = never> {
  readonly runScenario: (
    scenario: ExternalEffectConformanceScenario,
  ) => Effect.Effect<ExternalEffectConformanceScenarioResult, E, R>;
}

/**
 * Normalized result for one external-effect conformance scenario.
 *
 * @public
 */
export interface ExternalEffectConformanceScenarioReport {
  readonly scenario: ExternalEffectConformanceScenario;
  readonly status: "passed" | "failed";
  readonly summary?: string;
  readonly issues: ReadonlyArray<ExternalEffectConformanceIssue>;
  readonly evidence?: unknown;
}

/**
 * Structured external-effect conformance report.
 *
 * @public
 */
export interface ExternalEffectConformanceReport {
  readonly status: "passed" | "failed";
  readonly scenarios: ReadonlyArray<ExternalEffectConformanceScenarioReport>;
  readonly failures: ReadonlyArray<ExternalEffectConformanceScenarioReport>;
}

const failedScenarioReport = (
  scenario: ExternalEffectConformanceScenario,
  result: ExternalEffectConformanceScenarioResult,
  issue: ExternalEffectConformanceIssue,
): ExternalEffectConformanceScenarioReport => ({
  scenario,
  status: "failed",
  summary: result.summary,
  issues: [issue],
  ...(result.evidence === undefined ? {} : { evidence: result.evidence }),
});

const scenarioReport = (
  scenario: ExternalEffectConformanceScenario,
  result: ExternalEffectConformanceScenarioResult,
): ExternalEffectConformanceScenarioReport => {
  if (result.scenarioId !== scenario.id) {
    return failedScenarioReport(scenario, result, {
      code: "scenario_id_mismatch",
      message: `adapter returned ${result.scenarioId} for ${scenario.id}`,
    });
  }
  if (result.status === "failed") {
    const issues =
      result.issues.length === 0
        ? [
            {
              code: "scenario_failed_without_issue",
              message: "adapter marked scenario failed without a structured issue",
            },
          ]
        : result.issues;
    return {
      scenario,
      status: "failed",
      summary: result.summary,
      issues,
      ...(result.evidence === undefined ? {} : { evidence: result.evidence }),
    };
  }
  return {
    scenario,
    status: "passed",
    summary: result.summary,
    issues: [],
    ...(result.evidence === undefined ? {} : { evidence: result.evidence }),
  };
};

/**
 * Runs the vocabulary-neutral external-effect conformance scenario set.
 *
 * @public
 */
export const externalEffectConformance = <E = never, R = never>(
  adapter: ExternalEffectConformanceAdapter<E, R>,
): Effect.Effect<ExternalEffectConformanceReport, E, R> =>
  Effect.forEach(EXTERNAL_EFFECT_CONFORMANCE_SCENARIOS, (scenario) =>
    adapter.runScenario(scenario).pipe(Effect.map((result) => scenarioReport(scenario, result))),
  ).pipe(
    Effect.map((scenarios) => {
      const failures = scenarios.filter((scenario) => scenario.status === "failed");
      return {
        status: failures.length === 0 ? "passed" : "failed",
        scenarios,
        failures,
      };
    }),
  );
