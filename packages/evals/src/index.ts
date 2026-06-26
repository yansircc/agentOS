export type EvalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly EvalJsonValue[]
  | { readonly [key: string]: EvalJsonValue };

export type EvalJsonObject = { readonly [key: string]: EvalJsonValue };

export interface EvalCaseSpec<Input = unknown> {
  readonly id?: string;
  readonly input: Input;
  readonly tags?: readonly string[];
  readonly metadata?: EvalJsonObject;
}

export interface EvalCase<Input = unknown> {
  readonly id: string;
  readonly input: Input;
  readonly tags: readonly string[];
  readonly metadata: EvalJsonObject;
}

export interface EvalEventRecord {
  readonly id: number;
  readonly kind: string;
  readonly payload?: unknown;
  readonly timestamp?: string;
}

export interface EvalEventQuery {
  readonly afterId?: number;
}

export interface EvalObservation {
  readonly status?: string;
  readonly events: readonly EvalEventRecord[];
  readonly projections: ReadonlyMap<string, unknown>;
  readonly usage?: EvalJsonObject;
}

export type EvalAssertionCheck = (observation: EvalObservation) => boolean | Promise<boolean>;

export type EvalAssertion =
  | { readonly kind: "completed" }
  | { readonly kind: "waiting" }
  | { readonly kind: "failed"; readonly reason?: string }
  | { readonly kind: "called_tool"; readonly toolName: string }
  | { readonly kind: "not_called_tool"; readonly toolName: string }
  | { readonly kind: "used_no_tools" }
  | { readonly kind: "projection"; readonly name: string }
  | {
      readonly kind: "check";
      readonly name: string;
      readonly check: EvalAssertionCheck;
    };

export interface EvalSessionFacade {
  readonly submitTurn: (input: unknown) => Promise<unknown>;
  readonly inspect: (sessionRef: string) => Promise<unknown>;
  readonly list: () => Promise<unknown>;
  readonly command: (name: string, input?: unknown) => Promise<unknown>;
  readonly events: (query?: EvalEventQuery) => Promise<readonly EvalEventRecord[]>;
  readonly projection: (name: string, input?: unknown) => Promise<unknown>;
}

export interface EvalWorkflowFacade {
  readonly run: (input: unknown) => Promise<unknown>;
  readonly inspectRun: (workflowId: string, workflowRunId: string) => Promise<unknown>;
  readonly listRuns: (workflowId: string) => Promise<unknown>;
  readonly start: (name: string, input?: unknown) => Promise<unknown>;
  readonly inspect: (workflowRef: string) => Promise<unknown>;
}

export interface EvalHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface EvalChannelRequest {
  readonly method?: string;
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

export interface EvalChannelFacade {
  readonly request: (input: EvalChannelRequest) => Promise<EvalHttpResponse>;
  readonly dispatch: (channel: string, payload: unknown) => Promise<unknown>;
}

export interface EvalFacades {
  readonly sessions: EvalSessionFacade;
  readonly workflows: EvalWorkflowFacade;
  readonly channels: EvalChannelFacade;
}

export interface EvalContext<Input = unknown> {
  readonly case: EvalCase<Input>;
  readonly target: EvalTarget;
  readonly t: EvalFacades;
  readonly sessions: EvalSessionFacade;
  readonly workflows: EvalWorkflowFacade;
  readonly channels: EvalChannelFacade;
}

export type EvalRun<Input = unknown> = (context: EvalContext<Input>) => Promise<unknown>;

export interface EvalDefinitionSpec<Input = unknown> {
  readonly id?: string;
  readonly path?: string;
  readonly title?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly cases: readonly EvalCaseSpec<Input>[];
  readonly assertions?: readonly EvalAssertion[];
  readonly run?: EvalRun<Input>;
}

export interface EvalDefinition<Input = unknown> {
  readonly id: string;
  readonly path?: string;
  readonly title?: string;
  readonly description?: string;
  readonly tags: readonly string[];
  readonly cases: readonly EvalCase<Input>[];
  readonly assertions: readonly EvalAssertion[];
  readonly run?: EvalRun<Input>;
}

export type EvalTargetSpec =
  | { readonly kind: "local"; readonly command?: string; readonly cwd?: string }
  | {
      readonly kind: "remote";
      readonly baseUrl: string;
      readonly headers?: Readonly<Record<string, string>>;
    };

export type EvalTarget =
  | { readonly kind: "local"; readonly command?: string; readonly cwd?: string }
  | {
      readonly kind: "remote";
      readonly baseUrl: string;
      readonly headers: Readonly<Record<string, string>>;
    };

export interface EvalProviderNeedSpec {
  readonly id: string;
  readonly kind: "scripted" | "model";
  readonly provider?: string;
  readonly model?: string;
  readonly purpose?: string;
  readonly metadata?: EvalJsonObject;
}

export interface EvalProviderNeed {
  readonly id: string;
  readonly kind: "scripted" | "model";
  readonly provider?: string;
  readonly model?: string;
  readonly purpose?: string;
  readonly metadata: EvalJsonObject;
}

export interface EvalReporterSpec {
  readonly kind: "json" | "summary";
  readonly output?: string;
}

export interface EvalReporter {
  readonly kind: "json" | "summary";
  readonly output?: string;
}

export interface EvalConfigSpec {
  readonly target?: EvalTargetSpec;
  readonly providers?: readonly EvalProviderNeedSpec[];
  readonly reporters?: readonly EvalReporterSpec[];
  readonly timeoutMs?: number;
}

export interface EvalConfig {
  readonly target: EvalTarget;
  readonly providers: readonly EvalProviderNeed[];
  readonly reporters: readonly EvalReporter[];
  readonly timeoutMs: number;
}

const freezeArray = <T>(values: readonly T[]): readonly T[] => Object.freeze([...values]);

const freezeRecord = <T extends object>(value: T): Readonly<T> => Object.freeze({ ...value });

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const isEvalJsonValue = (value: unknown): value is EvalJsonValue => {
  if (value === null) return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean" || typeof value === "string") return true;
  if (Array.isArray(value)) return value.every(isEvalJsonValue);
  return isRecord(value) && Object.values(value).every(isEvalJsonValue);
};

const parseJsonObject = (value: unknown, label: string): EvalJsonObject => {
  if (!isRecord(value) || !Object.values(value).every(isEvalJsonValue)) {
    throw new TypeError(`${label} must be a JSON object`);
  }
  return freezeRecord(value as EvalJsonObject);
};

const requireNonEmpty = (value: string, label: string): string => {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new TypeError(`${label} must be non-empty`);
  }
  return normalized;
};

const normalizeTags = (tags: readonly string[] | undefined): readonly string[] =>
  freezeArray((tags ?? []).map((tag) => requireNonEmpty(tag, "tag")));

const normalizeMetadata = (metadata: EvalJsonObject | undefined): EvalJsonObject =>
  parseJsonObject(metadata ?? {}, "metadata");

const normalizeCase = <Input>(spec: EvalCaseSpec<Input>, index: number): EvalCase<Input> =>
  Object.freeze({
    id: requireNonEmpty(spec.id ?? `case-${index + 1}`, "case id"),
    input: spec.input,
    tags: normalizeTags(spec.tags),
    metadata: normalizeMetadata(spec.metadata),
  });

const hasOnlyKeys = (
  value: Readonly<Record<string, unknown>>,
  keys: ReadonlySet<string>,
  label: string,
): void => {
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) throw new TypeError(`${label} has unknown field ${key}`);
  }
};

const optionalStringArray = (value: unknown, label: string): readonly string[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new TypeError(`${label} must be a string array`);
  }
  return value;
};

const optionalJsonObject = (value: unknown, label: string): EvalJsonObject | undefined => {
  if (value === undefined) return undefined;
  return parseJsonObject(value, label);
};

const parseCaseSpec = (value: unknown): EvalCaseSpec => {
  if (!isRecord(value)) throw new TypeError("eval case must be an object");
  hasOnlyKeys(value, new Set(["id", "input", "tags", "metadata"]), "eval case");
  if (!Object.hasOwn(value, "input")) throw new TypeError("eval case input is required");
  return {
    ...(value.id === undefined
      ? {}
      : typeof value.id === "string"
        ? { id: value.id }
        : (() => {
            throw new TypeError("eval case id must be a string");
          })()),
    input: value.input,
    ...(value.tags === undefined
      ? {}
      : { tags: optionalStringArray(value.tags, "eval case tags") }),
    ...(value.metadata === undefined
      ? {}
      : { metadata: optionalJsonObject(value.metadata, "eval case metadata") }),
  };
};

const parseAssertion = (value: unknown): EvalAssertion => {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new TypeError("eval assertion must be an object with kind");
  }
  switch (value.kind) {
    case "completed":
    case "waiting":
    case "used_no_tools":
      hasOnlyKeys(value, new Set(["kind"]), `eval assertion ${value.kind}`);
      return value as EvalAssertion;
    case "failed":
      hasOnlyKeys(value, new Set(["kind", "reason"]), "eval assertion failed");
      if (value.reason !== undefined && typeof value.reason !== "string") {
        throw new TypeError("eval assertion failed reason must be a string");
      }
      return value as EvalAssertion;
    case "called_tool":
    case "not_called_tool":
      hasOnlyKeys(value, new Set(["kind", "toolName"]), `eval assertion ${value.kind}`);
      if (typeof value.toolName !== "string") {
        throw new TypeError(`eval assertion ${value.kind} toolName must be a string`);
      }
      return value as EvalAssertion;
    case "projection":
      hasOnlyKeys(value, new Set(["kind", "name"]), "eval assertion projection");
      if (typeof value.name !== "string") {
        throw new TypeError("eval assertion projection name must be a string");
      }
      return value as EvalAssertion;
    case "check":
      hasOnlyKeys(value, new Set(["kind", "name", "check"]), "eval assertion check");
      if (typeof value.name !== "string" || typeof value.check !== "function") {
        throw new TypeError("eval assertion check requires string name and function check");
      }
      return value as EvalAssertion;
    default:
      throw new TypeError(`unknown eval assertion kind ${value.kind}`);
  }
};

const parseTargetSpec = (value: unknown): EvalTargetSpec | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new TypeError("eval target must be an object with kind");
  }
  if (value.kind === "local") {
    hasOnlyKeys(value, new Set(["kind", "command", "cwd"]), "local eval target");
    if (value.command !== undefined && typeof value.command !== "string") {
      throw new TypeError("local eval target command must be a string");
    }
    if (value.cwd !== undefined && typeof value.cwd !== "string") {
      throw new TypeError("local eval target cwd must be a string");
    }
    return value as EvalTargetSpec;
  }
  if (value.kind === "remote") {
    hasOnlyKeys(value, new Set(["kind", "baseUrl", "headers"]), "remote eval target");
    if (typeof value.baseUrl !== "string") {
      throw new TypeError("remote eval target baseUrl must be a string");
    }
    if (
      value.headers !== undefined &&
      (!isRecord(value.headers) ||
        !Object.values(value.headers).every((entry) => typeof entry === "string"))
    ) {
      throw new TypeError("remote eval target headers must be a string record");
    }
    return value as EvalTargetSpec;
  }
  throw new TypeError(`unknown eval target kind ${value.kind}`);
};

const parseProviderNeedSpec = (value: unknown): EvalProviderNeedSpec => {
  if (!isRecord(value)) throw new TypeError("eval provider need must be an object");
  hasOnlyKeys(
    value,
    new Set(["id", "kind", "provider", "model", "purpose", "metadata"]),
    "eval provider need",
  );
  if (typeof value.id !== "string") throw new TypeError("eval provider id must be a string");
  if (value.kind !== "scripted" && value.kind !== "model") {
    throw new TypeError("eval provider kind must be scripted or model");
  }
  for (const key of ["provider", "model", "purpose"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      throw new TypeError(`eval provider ${key} must be a string`);
    }
  }
  return {
    id: value.id,
    kind: value.kind,
    ...(value.provider === undefined ? {} : { provider: value.provider as string }),
    ...(value.model === undefined ? {} : { model: value.model as string }),
    ...(value.purpose === undefined ? {} : { purpose: value.purpose as string }),
    ...(value.metadata === undefined
      ? {}
      : { metadata: optionalJsonObject(value.metadata, "eval provider metadata") }),
  };
};

const parseReporterSpec = (value: unknown): EvalReporterSpec => {
  if (!isRecord(value)) throw new TypeError("eval reporter must be an object");
  hasOnlyKeys(value, new Set(["kind", "output"]), "eval reporter");
  if (value.kind !== "json" && value.kind !== "summary") {
    throw new TypeError("eval reporter kind must be json or summary");
  }
  if (value.output !== undefined && typeof value.output !== "string") {
    throw new TypeError("eval reporter output must be a string");
  }
  return {
    kind: value.kind,
    ...(value.output === undefined ? {} : { output: value.output }),
  };
};

export const defineEvalDataset = <Input>(
  cases: readonly EvalCaseSpec<Input>[],
): readonly EvalCase<Input>[] => freezeArray(cases.map(normalizeCase));

export const evalIdFromPath = (
  filePath: string,
  options: { readonly root?: string } = {},
): string => {
  const normalizePath = (value: string): string =>
    value.replaceAll("\\", "/").replace(/\/+/gu, "/");
  let normalized = normalizePath(requireNonEmpty(filePath, "eval path"));
  const root =
    options.root === undefined ? undefined : normalizePath(options.root).replace(/\/$/u, "");
  if (root !== undefined && normalized.startsWith(`${root}/`)) {
    normalized = normalized.slice(root.length + 1);
  }
  normalized = normalized
    .replace(/^\.\//u, "")
    .replace(/^.*\/evals\//u, "")
    .replace(/^evals\//u, "")
    .replace(/\.(?:eval\.)?(?:[cm]?[jt]sx?)$/u, "")
    .replace(/[^a-zA-Z0-9._/-]+/gu, ".")
    .replace(/[/.]+/gu, ".")
    .replace(/^\.+|\.+$/gu, "")
    .toLowerCase();
  return requireNonEmpty(normalized, "eval id");
};

export const defineEval = <Input>(spec: EvalDefinitionSpec<Input>): EvalDefinition<Input> => {
  const id = requireNonEmpty(spec.id ?? evalIdFromPath(spec.path ?? ""), "eval id");
  const definition: EvalDefinition<Input> = {
    id,
    ...(spec.path === undefined ? {} : { path: spec.path }),
    ...(spec.title === undefined ? {} : { title: spec.title }),
    ...(spec.description === undefined ? {} : { description: spec.description }),
    tags: normalizeTags(spec.tags),
    cases: defineEvalDataset(spec.cases),
    assertions: freezeArray(spec.assertions ?? []),
    ...(spec.run === undefined ? {} : { run: spec.run }),
  };
  return Object.freeze(definition);
};

const normalizeTarget = (target: EvalTargetSpec | undefined): EvalTarget => {
  if (target === undefined || target.kind === "local") {
    return Object.freeze({
      kind: "local" as const,
      ...(target?.command === undefined ? {} : { command: target.command }),
      ...(target?.cwd === undefined ? {} : { cwd: target.cwd }),
    });
  }
  if (target.kind !== "remote") {
    throw new TypeError(`unknown eval target kind ${(target as { readonly kind?: unknown }).kind}`);
  }
  return Object.freeze({
    kind: "remote" as const,
    baseUrl: requireNonEmpty(target.baseUrl, "remote target baseUrl"),
    headers: freezeRecord(target.headers ?? {}),
  });
};

const normalizeProviderNeed = (provider: EvalProviderNeedSpec): EvalProviderNeed =>
  Object.freeze(
    provider.kind === "scripted" || provider.kind === "model"
      ? {
          id: requireNonEmpty(provider.id, "provider id"),
          kind: provider.kind,
          ...(provider.provider === undefined ? {} : { provider: provider.provider }),
          ...(provider.model === undefined ? {} : { model: provider.model }),
          ...(provider.purpose === undefined ? {} : { purpose: provider.purpose }),
          metadata: normalizeMetadata(provider.metadata),
        }
      : (() => {
          throw new TypeError(
            `unknown eval provider kind ${(provider as { readonly kind?: unknown }).kind}`,
          );
        })(),
  );

const normalizeReporter = (reporter: EvalReporterSpec): EvalReporter =>
  Object.freeze(
    reporter.kind === "json" || reporter.kind === "summary"
      ? {
          kind: reporter.kind,
          ...(reporter.output === undefined ? {} : { output: reporter.output }),
        }
      : (() => {
          throw new TypeError(
            `unknown eval reporter kind ${(reporter as { readonly kind?: unknown }).kind}`,
          );
        })(),
  );

export const defineEvalConfig = (spec: EvalConfigSpec = {}): EvalConfig =>
  Object.freeze({
    target: normalizeTarget(spec.target),
    providers: freezeArray((spec.providers ?? []).map(normalizeProviderNeed)),
    reporters: freezeArray((spec.reporters ?? [{ kind: "json" as const }]).map(normalizeReporter)),
    timeoutMs: spec.timeoutMs ?? 30_000,
  });

export const parseEvalDefinition = (value: unknown): EvalDefinition => {
  if (!isRecord(value)) throw new TypeError("eval definition must be an object");
  hasOnlyKeys(
    value,
    new Set(["id", "path", "title", "description", "tags", "cases", "assertions", "run"]),
    "eval definition",
  );
  if (!Array.isArray(value.cases)) throw new TypeError("eval definition cases must be an array");
  const assertions = value.assertions;
  if (assertions !== undefined && !Array.isArray(assertions)) {
    throw new TypeError("eval definition assertions must be an array");
  }
  for (const key of ["id", "path", "title", "description"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      throw new TypeError(`eval definition ${key} must be a string`);
    }
  }
  if (value.run !== undefined && typeof value.run !== "function") {
    throw new TypeError("eval definition run must be a function");
  }
  return defineEval({
    ...(value.id === undefined ? {} : { id: value.id as string }),
    ...(value.path === undefined ? {} : { path: value.path as string }),
    ...(value.title === undefined ? {} : { title: value.title as string }),
    ...(value.description === undefined ? {} : { description: value.description as string }),
    ...(value.tags === undefined
      ? {}
      : { tags: optionalStringArray(value.tags, "eval definition tags") }),
    cases: value.cases.map(parseCaseSpec),
    ...(assertions === undefined ? {} : { assertions: assertions.map(parseAssertion) }),
    ...(value.run === undefined ? {} : { run: value.run as EvalRun }),
  });
};

export const parseEvalConfig = (value: unknown): EvalConfig => {
  if (value === undefined) return defineEvalConfig();
  if (!isRecord(value)) throw new TypeError("eval config must be an object");
  hasOnlyKeys(value, new Set(["target", "providers", "reporters", "timeoutMs"]), "eval config");
  const providers = value.providers;
  if (providers !== undefined && !Array.isArray(providers)) {
    throw new TypeError("eval config providers must be an array");
  }
  const reporters = value.reporters;
  if (reporters !== undefined && !Array.isArray(reporters)) {
    throw new TypeError("eval config reporters must be an array");
  }
  if (value.timeoutMs !== undefined && typeof value.timeoutMs !== "number") {
    throw new TypeError("eval config timeoutMs must be a number");
  }
  return defineEvalConfig({
    ...(value.target === undefined ? {} : { target: parseTargetSpec(value.target) }),
    ...(providers === undefined ? {} : { providers: providers.map(parseProviderNeedSpec) }),
    ...(reporters === undefined ? {} : { reporters: reporters.map(parseReporterSpec) }),
    ...(value.timeoutMs === undefined ? {} : { timeoutMs: value.timeoutMs as number }),
  });
};

export const evalAssertion = Object.freeze({
  completed: (): EvalAssertion => Object.freeze({ kind: "completed" as const }),
  waiting: (): EvalAssertion => Object.freeze({ kind: "waiting" as const }),
  failed: (reason?: string): EvalAssertion =>
    Object.freeze({
      kind: "failed" as const,
      ...(reason === undefined ? {} : { reason }),
    }),
  calledTool: (toolName: string): EvalAssertion =>
    Object.freeze({
      kind: "called_tool" as const,
      toolName: requireNonEmpty(toolName, "tool name"),
    }),
  notCalledTool: (toolName: string): EvalAssertion =>
    Object.freeze({
      kind: "not_called_tool" as const,
      toolName: requireNonEmpty(toolName, "tool name"),
    }),
  usedNoTools: (): EvalAssertion => Object.freeze({ kind: "used_no_tools" as const }),
  projection: (name: string): EvalAssertion =>
    Object.freeze({ kind: "projection" as const, name: requireNonEmpty(name, "projection name") }),
  check: (name: string, check: EvalAssertionCheck): EvalAssertion =>
    Object.freeze({ kind: "check" as const, name: requireNonEmpty(name, "check name"), check }),
});
