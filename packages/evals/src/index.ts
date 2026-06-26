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
  readonly kind: string;
  readonly payload?: unknown;
  readonly timestamp?: string;
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
  readonly events: (sessionId?: string) => Promise<readonly EvalEventRecord[]>;
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
  freezeRecord(metadata ?? {});

const normalizeCase = <Input>(spec: EvalCaseSpec<Input>, index: number): EvalCase<Input> =>
  Object.freeze({
    id: requireNonEmpty(spec.id ?? `case-${index + 1}`, "case id"),
    input: spec.input,
    tags: normalizeTags(spec.tags),
    metadata: normalizeMetadata(spec.metadata),
  });

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
  return Object.freeze({
    kind: "remote" as const,
    baseUrl: requireNonEmpty(target.baseUrl, "remote target baseUrl"),
    headers: freezeRecord(target.headers ?? {}),
  });
};

const normalizeProviderNeed = (provider: EvalProviderNeedSpec): EvalProviderNeed =>
  Object.freeze({
    id: requireNonEmpty(provider.id, "provider id"),
    kind: provider.kind,
    ...(provider.provider === undefined ? {} : { provider: provider.provider }),
    ...(provider.model === undefined ? {} : { model: provider.model }),
    ...(provider.purpose === undefined ? {} : { purpose: provider.purpose }),
    metadata: normalizeMetadata(provider.metadata),
  });

const normalizeReporter = (reporter: EvalReporterSpec): EvalReporter =>
  Object.freeze({
    kind: reporter.kind,
    ...(reporter.output === undefined ? {} : { output: reporter.output }),
  });

export const defineEvalConfig = (spec: EvalConfigSpec = {}): EvalConfig =>
  Object.freeze({
    target: normalizeTarget(spec.target),
    providers: freezeArray((spec.providers ?? []).map(normalizeProviderNeed)),
    reporters: freezeArray((spec.reporters ?? [{ kind: "json" as const }]).map(normalizeReporter)),
    timeoutMs: spec.timeoutMs ?? 30_000,
  });

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
