import { Context, Effect, Predicate } from "effect";
import { ToolError } from "@agent-os/core/errors";
import {
  EXTERNAL_TOOL_EXECUTION_REQUIRES_RECEIPT_REASON,
  RUNTIME_FACT_OWNER,
  type ToolArgumentSummary,
  type ToolRejectedDiagnostics,
} from "@agent-os/core/runtime-protocol";
import type { BoundaryContract } from "@agent-os/core/boundary-contract";
import type { PreClaim } from "@agent-os/core/effect-claim";
import type {
  ToolExecutionContextInput,
  ToolProjectionWaitSpec,
  MaterialBrokerReceipt,
} from "@agent-os/core/tools";
import type { InternalSubmitSpec } from "../internal-submit";
import { BoundaryEvents } from "../boundary-events";
import { MaterializedProjections, ProjectionWaitTimedOut, waitForProjection } from "../projection";
import {
  RUNTIME_DIAGNOSTIC_KIND,
  runtimeDiagnosticBoundaryContract,
} from "../runtime-diagnostic-carrier";
import type { ResolvedRuntimeGraphStatus } from "../runtime-graph-status";

const toolArgumentSummaryEncoder = new TextEncoder();

export const summarizeToolArguments = (value: unknown): ToolArgumentSummary => {
  if (typeof value === "string") {
    return {
      type: "string",
      bytes: toolArgumentSummaryEncoder.encode(value).byteLength,
      truncated: false,
    };
  }
  if (Array.isArray(value)) {
    return { type: "array", keys: [], truncated: value.length > 0 };
  }
  if (Predicate.isObject(value)) {
    const keys = Object.keys(value).sort();
    return {
      type: "object",
      keys: keys.slice(0, 20),
      truncated: keys.length > 20,
    };
  }
  return { type: value === null ? "null" : typeof value };
};

export const schemaIssuesFromToolError = (
  error: ToolError,
): ToolRejectedDiagnostics["schemaIssues"] | undefined => {
  const cause = error.cause;
  if (!Predicate.isObject(cause) || !Array.isArray(cause.schemaIssues)) return undefined;
  const issues = cause.schemaIssues.filter(
    (issue): issue is { readonly path: string; readonly issue: string } =>
      Predicate.isObject(issue) &&
      typeof issue.path === "string" &&
      typeof issue.issue === "string",
  );
  return issues.length === 0 ? undefined : issues;
};

export const receiptBackedToolBindingReason = (
  spec: InternalSubmitSpec,
  toolName: string,
): string | null => {
  const binding = spec.receiptBackedTools?.[toolName];
  if (binding === undefined) return EXTERNAL_TOOL_EXECUTION_REQUIRES_RECEIPT_REASON;
  const declaredIntentKinds = new Set((spec.toolIntents ?? []).map((intent) => intent.kind));
  return binding.intentKinds.every((kind) => declaredIntentKinds.has(kind))
    ? null
    : "receipt_backed_tool_missing_declared_intent";
};

export const claimMatchesPreClaim = (
  claim: {
    readonly operationRef: string;
    readonly scopeRef: PreClaim["scopeRef"];
    readonly effectAuthorityRef: PreClaim["effectAuthorityRef"];
    readonly originRef: PreClaim["originRef"];
  },
  preClaim: PreClaim,
): boolean =>
  claim.operationRef === preClaim.operationRef &&
  claim.scopeRef.kind === preClaim.scopeRef.kind &&
  claim.scopeRef.scopeId === preClaim.scopeRef.scopeId &&
  (claim.scopeRef.kind !== "external" ||
    (preClaim.scopeRef.kind === "external" &&
      claim.scopeRef.systemRef === preClaim.scopeRef.systemRef)) &&
  claim.effectAuthorityRef.authorityClass === preClaim.effectAuthorityRef.authorityClass &&
  claim.effectAuthorityRef.authorityId === preClaim.effectAuthorityRef.authorityId &&
  claim.effectAuthorityRef.version === preClaim.effectAuthorityRef.version &&
  claim.originRef.originKind === preClaim.originRef.originKind &&
  claim.originRef.originId === preClaim.originRef.originId &&
  claim.originRef.version === preClaim.originRef.version;

export const payloadWithToolPreClaim = (
  contract: BoundaryContract,
  kind: string,
  payload: unknown,
  claim: PreClaim,
): unknown => {
  const claimContract = contract.events[kind]?.claim;
  if (claimContract?.phase !== "pre") return payload;
  return Predicate.isObject(payload) ? { ...payload, [claimContract.key]: claim } : payload;
};

const authorityRefLabel = (authority: PreClaim["effectAuthorityRef"]): string =>
  authority.version === undefined
    ? `${authority.authorityClass}:${authority.authorityId}`
    : `${authority.authorityClass}:${authority.authorityId}@${authority.version}`;

const requestedEventIdFromProjectionIdentity = (identity: unknown): number | undefined =>
  Predicate.isObject(identity) &&
  typeof (identity as { readonly requestedEventId?: unknown }).requestedEventId === "number"
    ? (identity as { readonly requestedEventId: number }).requestedEventId
    : undefined;

const recordProjectionTimeoutDiagnostic = <State>(
  boundaryEvents: Context.Service.Shape<typeof BoundaryEvents>,
  projectionSpec: ToolProjectionWaitSpec<State>,
  claim: PreClaim,
  timeout: ProjectionWaitTimedOut,
  graphStatus: ResolvedRuntimeGraphStatus | undefined,
): Effect.Effect<void> => {
  const requestedEventId = requestedEventIdFromProjectionIdentity(projectionSpec.identity);
  if (requestedEventId === undefined) return Effect.void;
  const projectionStatus = graphStatus?.projection(timeout.projectionKind);
  return boundaryEvents
    .commit(runtimeDiagnosticBoundaryContract, RUNTIME_DIAGNOSTIC_KIND.PROJECTION_TIMEOUT, {
      capabilityId:
        projectionStatus?.status === "installed"
          ? projectionStatus.capabilityId
          : RUNTIME_FACT_OWNER,
      projectionKind: timeout.projectionKind,
      waitReason: timeout.reason,
      maxAttempts: timeout.maxAttempts,
      operationRef: claim.operationRef,
      authority: authorityRefLabel(projectionSpec.effectAuthorityRef ?? claim.effectAuthorityRef),
      requestedEventId,
      ...(timeout.lastObservedEventId === undefined
        ? {}
        : { lastObservedEventId: timeout.lastObservedEventId }),
    })
    .pipe(Effect.asVoid, Effect.ignore);
};

export const runtimeToolContext = (
  spec: InternalSubmitSpec,
  boundaryEvents: Context.Service.Shape<typeof BoundaryEvents>,
  projections: Context.Service.Shape<typeof MaterializedProjections>,
  claim: PreClaim,
  resume: unknown,
  materialBrokerReceipts: ReadonlyArray<MaterialBrokerReceipt> = [],
  graphStatus?: ResolvedRuntimeGraphStatus,
): ToolExecutionContextInput => {
  const declaredIntents = new Map((spec.toolIntents ?? []).map((intent) => [intent.kind, intent]));
  return {
    ...spec.toolContext,
    ...(resume === undefined ? {} : { resume }),
    ...(materialBrokerReceipts.length === 0 ? {} : { materialBrokerReceipts }),
    ...(declaredIntents.size === 0
      ? {}
      : {
          emitIntent: (kind, payload) => {
            const declared = declaredIntents.get(kind);
            if (declared === undefined) {
              return Effect.fail(
                new ToolError({
                  toolName: "emitIntent",
                  cause: { reason: "undeclared_intent", kind },
                }),
              );
            }
            return boundaryEvents
              .commit(
                declared.boundaryPackage.boundaryContract,
                kind,
                payloadWithToolPreClaim(
                  declared.boundaryPackage.boundaryContract,
                  kind,
                  payload,
                  claim,
                ),
              )
              .pipe(
                Effect.map((event) => ({ id: event.id })),
                Effect.mapError((cause) => new ToolError({ toolName: "emitIntent", cause })),
              );
          },
        }),
    awaitProjection: <State = unknown>(projectionSpec: ToolProjectionWaitSpec<State>) => {
      const ready = projectionSpec.ready;
      return waitForProjection({
        kind: projectionSpec.kind,
        scopeRef: projectionSpec.scopeRef ?? spec.scopeRef,
        effectAuthorityRef: projectionSpec.effectAuthorityRef ?? spec.effectAuthorityRef,
        factOwnerRef: projectionSpec.factOwnerRef ?? RUNTIME_FACT_OWNER,
        identity: projectionSpec.identity,
        maxAttempts: projectionSpec.maxAttempts,
        pollIntervalMs: projectionSpec.pollIntervalMs,
        ready:
          ready === undefined
            ? undefined
            : (row) =>
                ready({
                  kind: row.kind,
                  projectionKind: row.kind,
                  identityKey: row.identityKey,
                  state: row.state as State,
                  updatedEventId: row.updatedEventId,
                }),
      }).pipe(
        Effect.provideService(MaterializedProjections, projections),
        Effect.tapError((cause) =>
          cause instanceof ProjectionWaitTimedOut
            ? recordProjectionTimeoutDiagnostic(
                boundaryEvents,
                projectionSpec,
                claim,
                cause,
                graphStatus,
              )
            : Effect.void,
        ),
        Effect.mapError((cause) => new ToolError({ toolName: "awaitProjection", cause })),
        Effect.map((row) => ({
          kind: row.kind,
          projectionKind: row.kind,
          identityKey: row.identityKey,
          state: row.state as State,
          updatedEventId: row.updatedEventId,
        })),
      );
    },
  };
};

export const toolBudgetTimeCause = (
  elapsedMs: number,
  maxMs: number,
): {
  readonly reason: "budget_time";
  readonly elapsedMs: number;
  readonly maxMs: number;
} => ({
  reason: "budget_time",
  elapsedMs,
  maxMs,
});

export const isToolBudgetTimeError = (error: ToolError): boolean => {
  const cause = error.cause;
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { readonly reason?: unknown }).reason === "budget_time"
  );
};

export const toolBudgetTimePayload = (
  error: ToolError,
): { readonly elapsedMs: number; readonly maxMs: number } => {
  const cause = error.cause as {
    readonly elapsedMs?: unknown;
    readonly maxMs?: unknown;
  };
  return {
    elapsedMs: typeof cause.elapsedMs === "number" ? cause.elapsedMs : 0,
    maxMs: typeof cause.maxMs === "number" ? cause.maxMs : 0,
  };
};
