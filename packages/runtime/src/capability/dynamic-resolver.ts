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
  readonly resolve: (context: DynamicCapabilityContext) => unknown | Promise<unknown>;
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
    };

export type DynamicCapabilityResolverServiceResult =
  | { readonly ok: true; readonly projection: DynamicCapabilityProjection }
  | { readonly ok: false; readonly issues: ReadonlyArray<DynamicCapabilityResolverServiceIssue> };

const DEFAULT_DYNAMIC_RESOLVER_TIMEOUT_MS = 1_000;

const freezeRecord = <Value>(
  value: Readonly<Record<string, Value>> | undefined,
): Readonly<Record<string, Value>> => Object.freeze({ ...(value ?? {}) });

const freezeCatalog = (
  catalog: DynamicCapabilityCompiledCatalog,
): DynamicCapabilityCompiledCatalog =>
  Object.freeze({
    tools: Object.freeze(catalog.tools.map((tool) => Object.freeze({ ...tool }))),
    skills: Object.freeze(catalog.skills.map((skill) => Object.freeze({ ...skill }))),
    instructions: Object.freeze(
      catalog.instructions.map((instruction) => Object.freeze({ ...instruction })),
    ),
  });

const freezeDynamicCapabilityRunInput = (
  input: DynamicCapabilityRunInput | undefined,
): DynamicCapabilityRunInput =>
  Object.freeze({
    ...(input?.phase === undefined ? {} : { phase: input.phase }),
    values: freezeRecord(input?.values),
  });

export const makeDynamicCapabilityContext = (
  input: Omit<DynamicCapabilityResolverServiceInput, "resolvers" | "timeoutMs">,
): DynamicCapabilityContext =>
  Object.freeze({
    event: Object.freeze({ ...input.event }),
    catalog: freezeCatalog(input.catalog),
    input: freezeDynamicCapabilityRunInput(input.input),
    auth: freezeRecord(input.auth),
    projections: freezeRecord(input.projections),
    materials: freezeRecord(input.materials),
  });

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

const withTimeout = async (
  run: () => unknown | Promise<unknown>,
  timeoutMs: number,
): Promise<
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: DynamicCapabilityFailureReason }
> =>
  new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, reason: DYNAMIC_CAPABILITY_FAILURE_REASON.RESOLVER_TIMEOUT });
    }, timeoutMs);
    Promise.resolve()
      .then(run)
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
    () => resolver.resolve(context),
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
  const duplicateIssues = duplicateResolverIssues(input.resolvers);
  if (duplicateIssues.length > 0) return { ok: false, issues: duplicateIssues };

  const runnableSlots = new Set(dynamicCapabilitySlotsForEvent(input.event.name));
  const runnableResolvers = input.resolvers.filter((resolver) => runnableSlots.has(resolver.slot));
  const context = makeDynamicCapabilityContext(input);
  const results = await Promise.all(
    runnableResolvers.map((resolver) =>
      runResolver(
        resolver,
        context,
        input.event,
        input.timeoutMs ?? DEFAULT_DYNAMIC_RESOLVER_TIMEOUT_MS,
      ),
    ),
  );
  const merged = mergeDynamicCapabilityProjection({
    event: input.event,
    catalog: input.catalog,
    results,
  });
  if (!merged.ok) return { ok: false, issues: [{ kind: "merge_failed", issues: merged.issues }] };
  return { ok: true, projection: merged.value };
};
