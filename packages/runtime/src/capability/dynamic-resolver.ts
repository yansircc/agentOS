import {
  DYNAMIC_CAPABILITY_FAILURE_REASON,
  DYNAMIC_CAPABILITY_RESOLVER_STATUS,
  type DynamicCapabilityCompiledCatalog,
  type DynamicCapabilityContext,
  type DynamicCapabilityEventRef,
  type DynamicCapabilityFailureReason,
  type DynamicCapabilityMergeIssue,
  type DynamicCapabilityProjection,
  type DynamicCapabilityRunInput,
  type DynamicCapabilityResolverMergeInput,
  type DynamicCapabilityResolverProvenance,
  type DynamicCapabilityResolverResult,
  type DynamicCapabilitySlot,
  dynamicCapabilitySlotsForEvent,
  mergeDynamicCapabilityProjection,
  parseDynamicCapabilityResolverResult,
} from "@agent-os/core/runtime-protocol";
import type { MaterialRef } from "@agent-os/core/material-ref";

export interface DynamicCapabilityResolverDefinition {
  readonly resolverId: string;
  readonly slot: DynamicCapabilitySlot;
  readonly timeoutMs?: number;
  readonly resolve: (
    context: DynamicCapabilityContext,
    signal: AbortSignal,
  ) => unknown | Promise<unknown>;
}

export interface DynamicCapabilityResolverServiceInput {
  readonly event: DynamicCapabilityEventRef;
  readonly catalog: DynamicCapabilityCompiledCatalog;
  readonly resolvers: ReadonlyArray<DynamicCapabilityResolverDefinition>;
  readonly input?: DynamicCapabilityRunInput;
  readonly auth?: Readonly<Record<string, unknown>>;
  readonly projections?: Readonly<Record<string, unknown>>;
  readonly materials?: Readonly<Record<string, MaterialRef>>;
  readonly timeoutMs?: number;
}

export type DynamicCapabilityResolverServiceIssue =
  | {
      readonly kind: "merge_failed";
      readonly issues: ReadonlyArray<DynamicCapabilityMergeIssue>;
    }
  | {
      readonly kind: "resolver_id_duplicate";
      readonly resolverId: string;
      readonly slot: DynamicCapabilitySlot;
    }
  | {
      readonly kind: "timeout_invalid";
      readonly owner:
        | { readonly kind: "service" }
        | {
            readonly kind: "resolver";
            readonly resolverId: string;
            readonly slot: DynamicCapabilitySlot;
          };
      readonly timeoutMs: number;
    }
  | {
      readonly kind: "context_invalid";
      readonly path: string;
      readonly reason: "json_value_required" | "acyclic_value_required";
    };

export type DynamicCapabilityResolverServiceResult =
  | { readonly ok: true; readonly projection: DynamicCapabilityProjection }
  | { readonly ok: false; readonly issues: ReadonlyArray<DynamicCapabilityResolverServiceIssue> };

type DynamicCapabilityContextIssue = Extract<
  DynamicCapabilityResolverServiceIssue,
  { readonly kind: "context_invalid" }
>;

const DEFAULT_DYNAMIC_RESOLVER_TIMEOUT_MS = 1_000;

type JsonSnapshotResult =
  | { readonly ok: true; readonly value: unknown }
  | {
      readonly ok: false;
      readonly path: string;
      readonly reason: "json_value_required" | "acyclic_value_required";
    };

const jsonSnapshot = (
  value: unknown,
  path: string,
  ancestors: ReadonlyArray<object>,
): JsonSnapshotResult => {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return { ok: true, value };
  }
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? { ok: true, value }
      : { ok: false, path, reason: "json_value_required" };
  }
  if (typeof value !== "object") {
    return { ok: false, path, reason: "json_value_required" };
  }
  if (ancestors.includes(value)) {
    return { ok: false, path, reason: "acyclic_value_required" };
  }

  const isArray = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (!isArray && prototype !== Object.prototype && prototype !== null) {
    return { ok: false, path, reason: "json_value_required" };
  }

  const descendants = [...ancestors, value];
  if (isArray) {
    const output: unknown[] = [];
    const unexpectedKey = Reflect.ownKeys(value).find((key) => {
      if (key === "length") return false;
      if (typeof key !== "string") return true;
      const index = Number(key);
      return (
        !Number.isInteger(index) || index < 0 || index >= value.length || String(index) !== key
      );
    });
    if (unexpectedKey !== undefined) {
      return {
        ok: false,
        path: `${path}[${
          typeof unexpectedKey === "symbol"
            ? unexpectedKey.toString()
            : JSON.stringify(unexpectedKey)
        }]`,
        reason: "json_value_required",
      };
    }
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        return { ok: false, path: `${path}[${index}]`, reason: "json_value_required" };
      }
      const entry = jsonSnapshot(descriptor.value, `${path}[${index}]`, descendants);
      if (!entry.ok) return entry;
      output.push(entry.value);
    }
    return { ok: true, value: Object.freeze(output) };
  }

  const output = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      return {
        ok: false,
        path: `${path}[${key.toString()}]`,
        reason: "json_value_required",
      };
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    const keyPath = `${path}[${JSON.stringify(key)}]`;
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      return { ok: false, path: keyPath, reason: "json_value_required" };
    }
    const entry = jsonSnapshot(descriptor.value, keyPath, descendants);
    if (!entry.ok) return entry;
    output[key] = entry.value;
  }
  return { ok: true, value: Object.freeze(output) };
};

const dynamicCapabilityContextSnapshot = (
  input: Omit<DynamicCapabilityResolverServiceInput, "resolvers" | "timeoutMs">,
):
  | { readonly ok: true; readonly value: DynamicCapabilityContext }
  | { readonly ok: false; readonly issue: DynamicCapabilityContextIssue } => {
  const snapshot = jsonSnapshot(
    {
      event: input.event,
      catalog: input.catalog,
      input: {
        ...(input.input?.phase === undefined ? {} : { phase: input.input.phase }),
        values: input.input?.values ?? {},
      },
      auth: input.auth ?? {},
      projections: input.projections ?? {},
      materials: input.materials ?? {},
    },
    "$",
    [],
  );
  return snapshot.ok
    ? { ok: true, value: snapshot.value as DynamicCapabilityContext }
    : {
        ok: false,
        issue: {
          kind: "context_invalid",
          path: snapshot.path,
          reason: snapshot.reason,
        },
      };
};

export const makeDynamicCapabilityContext = (
  input: Omit<DynamicCapabilityResolverServiceInput, "resolvers" | "timeoutMs">,
) => dynamicCapabilityContextSnapshot(input);

const resolverKey = (resolver: Pick<DynamicCapabilityResolverDefinition, "resolverId" | "slot">) =>
  `${resolver.slot}/${resolver.resolverId}`;

const duplicateResolverIssues = (
  resolvers: ReadonlyArray<DynamicCapabilityResolverDefinition>,
): ReadonlyArray<DynamicCapabilityResolverServiceIssue> => {
  const seen = new Set<string>();
  const issues: DynamicCapabilityResolverServiceIssue[] = [];
  for (const resolver of resolvers) {
    const key = resolverKey(resolver);
    if (seen.has(key)) {
      issues.push({
        kind: "resolver_id_duplicate",
        resolverId: resolver.resolverId,
        slot: resolver.slot,
      });
      continue;
    }
    seen.add(key);
  }
  return issues;
};

const isValidTimeout = (timeoutMs: number): boolean =>
  Number.isFinite(timeoutMs) && Number.isInteger(timeoutMs) && timeoutMs > 0;

const invalidTimeoutIssues = (
  input: DynamicCapabilityResolverServiceInput,
): ReadonlyArray<DynamicCapabilityResolverServiceIssue> => {
  const issues: DynamicCapabilityResolverServiceIssue[] = [];
  if (input.timeoutMs !== undefined && !isValidTimeout(input.timeoutMs)) {
    issues.push({
      kind: "timeout_invalid",
      owner: { kind: "service" },
      timeoutMs: input.timeoutMs,
    });
  }
  for (const resolver of input.resolvers) {
    if (resolver.timeoutMs === undefined || isValidTimeout(resolver.timeoutMs)) continue;
    issues.push({
      kind: "timeout_invalid",
      owner: {
        kind: "resolver",
        resolverId: resolver.resolverId,
        slot: resolver.slot,
      },
      timeoutMs: resolver.timeoutMs,
    });
  }
  return issues;
};

const withTimeout = async (
  run: (signal: AbortSignal) => unknown | Promise<unknown>,
  timeoutMs: number,
): Promise<
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: DynamicCapabilityFailureReason }
> =>
  new Promise((resolve) => {
    let settled = false;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      controller.abort();
      resolve({ ok: false, reason: DYNAMIC_CAPABILITY_FAILURE_REASON.RESOLVER_TIMEOUT });
    }, timeoutMs);
    Promise.resolve()
      .then(() => run(controller.signal))
      .then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ ok: true, value });
        },
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ ok: false, reason: DYNAMIC_CAPABILITY_FAILURE_REASON.RESOLVER_THROW });
        },
      );
  });

const failedResolver = (
  resolver: DynamicCapabilityResolverDefinition,
  event: DynamicCapabilityEventRef,
  reason: DynamicCapabilityFailureReason,
): DynamicCapabilityResolverMergeInput => ({
  provenance: {
    resolverId: resolver.resolverId,
    slot: resolver.slot,
    eventName: event.name,
    status: DYNAMIC_CAPABILITY_RESOLVER_STATUS.FAILED,
    reason,
  },
  result: {},
});

const timedOutResolver = (
  resolver: DynamicCapabilityResolverDefinition,
  event: DynamicCapabilityEventRef,
): DynamicCapabilityResolverMergeInput => ({
  provenance: {
    resolverId: resolver.resolverId,
    slot: resolver.slot,
    eventName: event.name,
    status: DYNAMIC_CAPABILITY_RESOLVER_STATUS.TIMED_OUT,
    reason: DYNAMIC_CAPABILITY_FAILURE_REASON.RESOLVER_TIMEOUT,
  },
  result: {},
});

const appliedResolver = (
  resolver: DynamicCapabilityResolverDefinition,
  event: DynamicCapabilityEventRef,
  result: DynamicCapabilityResolverResult,
): DynamicCapabilityResolverMergeInput => ({
  provenance: {
    resolverId: resolver.resolverId,
    slot: resolver.slot,
    eventName: event.name,
    status: DYNAMIC_CAPABILITY_RESOLVER_STATUS.APPLIED,
  },
  result,
});

const runResolver = async (
  resolver: DynamicCapabilityResolverDefinition,
  context: DynamicCapabilityContext,
  event: DynamicCapabilityEventRef,
  timeoutMs: number,
): Promise<DynamicCapabilityResolverMergeInput> => {
  const resolved = await withTimeout(
    (signal) => resolver.resolve(context, signal),
    resolver.timeoutMs ?? timeoutMs,
  );
  if (!resolved.ok) {
    return resolved.reason === DYNAMIC_CAPABILITY_FAILURE_REASON.RESOLVER_TIMEOUT
      ? timedOutResolver(resolver, event)
      : failedResolver(resolver, event, resolved.reason);
  }
  const parsed = parseDynamicCapabilityResolverResult(resolved.value);
  if (!parsed.ok) {
    return failedResolver(resolver, event, DYNAMIC_CAPABILITY_FAILURE_REASON.INVALID_OUTPUT);
  }
  return appliedResolver(resolver, event, parsed.value);
};

export const runDynamicCapabilityResolvers = async (
  input: DynamicCapabilityResolverServiceInput,
): Promise<DynamicCapabilityResolverServiceResult> => {
  const inputIssues = [...duplicateResolverIssues(input.resolvers), ...invalidTimeoutIssues(input)];
  if (inputIssues.length > 0) return { ok: false, issues: inputIssues };

  const runnableSlots = new Set(dynamicCapabilitySlotsForEvent(input.event.name));
  const runnableResolvers = input.resolvers.filter((resolver) => runnableSlots.has(resolver.slot));
  const contextSnapshot = makeDynamicCapabilityContext(input);
  if (!contextSnapshot.ok) return { ok: false, issues: [contextSnapshot.issue] };
  const context = contextSnapshot.value;
  const results = await Promise.all(
    runnableResolvers.map((resolver) =>
      runResolver(
        resolver,
        context,
        context.event,
        input.timeoutMs ?? DEFAULT_DYNAMIC_RESOLVER_TIMEOUT_MS,
      ),
    ),
  );
  const merged = mergeDynamicCapabilityProjection({
    event: context.event,
    catalog: context.catalog,
    results,
  });
  if (!merged.ok) return { ok: false, issues: [{ kind: "merge_failed", issues: merged.issues }] };
  return { ok: true, projection: merged.value };
};
