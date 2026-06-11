/**
 * submitAgentEffect — the agent loop.
 *
 * Loop terminates on exactly three conditions:
 *   1. LLM returns no more tool calls (natural stop) -> complete
 *   2. Any budget dimension exhausted -> abort
 *   3. Tool dispatch retry exhausted -> abort
 *
 * All recoverable failures (UpstreamFailure, ToolError) are caught and
 * funneled through finalAbort, which logs an agent.aborted.* ledger event
 * before returning SubmitResult{ok:false}. Only SqlError | JsonStringifyError
 * escape (irrecoverable infra failures).
 *
 * submitAgentEffect is module-private. Apps call Cloudflare backend.submit(spec)
 * which injects scope from ctx.id.name (SSoT) and runs this effect.
 */

import { Clock, Context, Data, Duration, Effect, Predicate, Ref } from "effect";
import {
  DECISION_GATE_KIND,
  decisionGateBoundaryContract,
  projectDecisionGate,
  settleDecisionGateConsumed,
} from "@agent-os/decision-gate";
import {
  JsonStringifyError,
  safeStringify,
  safeStringifyPretty,
  SqlError,
  ToolError,
  UpstreamFailure,
} from "@agent-os/kernel/errors";
import { ABORT, type AbortKind } from "@agent-os/kernel/abort";
import {
  textFromLlmOutputItems,
  toolCallsFromLlmOutputItems,
  type LlmToolCall,
  type LlmMessage,
  type LlmRoute,
} from "@agent-os/llm-protocol";
import { LlmTransport } from "@agent-os/llm-protocol";
import type { ToolDefinition } from "@agent-os/kernel/tools";
import type { LedgerEvent } from "@agent-os/kernel/types";
import {
  isMaterialRef,
  materialRefKey,
  materialRefSatisfiesRequirement,
} from "@agent-os/kernel/material-ref";
import {
  InvalidTraceContext,
  copyTraceContext,
  validateOptionalTraceContext,
  type TraceContext,
} from "@agent-os/telemetry-protocol";
import {
  agentRunAbortedEvent,
  agentRunCompletedEvent,
  agentRunInterruptedEvent,
  agentRunResumedEvent,
  agentRunStartedEvent,
  chatIngestedEvent,
  decodeRuntimeLedgerEvent,
  EXTERNAL_TOOL_EXECUTION_REQUIRES_RECEIPT_REASON,
  llmResponseEvent,
  RUNTIME_FACT_OWNER,
  RUNTIME_EVENT_KIND,
  receiptBackedToolResultFromUnknown,
  toolExecutedEvent,
  toolReplayArtifactFromExecutedPayload,
  toolRejectedEvent,
  replayToolFromArtifact,
  type InternalSubmitSpec,
  type RuntimeEventCommitSpec,
  type SubmitDecisionInterrupt,
  type SubmitResult,
  type ToolArgumentSummary,
  type ToolRejectedDiagnostics,
  type TurnRef,
} from "@agent-os/runtime-protocol";
import type { LedgerCommitEventSpec, LedgerTruthIdentity } from "@agent-os/runtime-protocol";
import { Ledger } from "./ledger";
import {
  RefResolverService,
  type RefResolutionFailed,
  type ResolvedMaterial,
  type ResolvedMaterialService,
} from "@agent-os/kernel/ref-resolver";
import { Quota } from "./quota-service";
import {
  decodeToolArgs,
  executeTool,
  resolveToolExecution,
  validateExecutionDomainRegistry,
  validateToolRegistry,
  type ExecutionDomainDeclaration,
  type Tool,
  type ToolExecutionContextInput,
  type ToolProjectionWaitSpec,
  type ResolvedToolMaterials,
} from "@agent-os/kernel/tools";
import { makeAdmissionSchemaSpec } from "@agent-os/runtime-protocol";
import { Admission } from "./admission";
import { projectSubmitResult } from "./run-projector";
import {
  admitterErrorRejectionRef,
  makeOperationRef,
  makePreClaim,
  normalizeAdmitVerdict,
  type PreClaim,
  type RejectionRef,
} from "@agent-os/kernel/effect-claim";
import {
  settleToolAdmissionRejected,
  settleToolExecuted,
  settleToolExecutionRejected,
  settleToolValidationRejected,
  toolAdmissionFailureCause,
  toolErrorReason,
  publicRuntimeCauseReason,
} from "./tool-settlement";
import { BoundaryEvents } from "./boundary-events";
import type { BoundaryCommitRejected } from "./boundary-commit";
import { MaterializedProjections, waitForProjection } from "./projection";
import type { BoundaryContract } from "@agent-os/kernel/boundary-contract";

export const DEFAULT_LLM_CALL_TIMEOUT_MS = 60_000;

export const turnRefOf = (runId: number, index: number): TurnRef => ({
  id: runId,
  index,
});

class LlmCallTimedOut extends Data.TaggedError("agent_os.llm_call_timed_out")<{
  readonly mode: "budget" | "provider";
  readonly elapsedMs: number;
  readonly timeoutMs: number;
}> {}

const toolDefinitionsOf = (tools: Record<string, Tool>): ReadonlyArray<ToolDefinition> =>
  Object.values(tools).map((t) => t.definition);

const toolArgumentSummaryEncoder = new TextEncoder();

const summarizeToolArguments = (value: unknown): ToolArgumentSummary => {
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
  if (Predicate.isRecord(value)) {
    const keys = Object.keys(value).sort();
    return {
      type: "object",
      keys: keys.slice(0, 20),
      truncated: keys.length > 20,
    };
  }
  return { type: value === null ? "null" : typeof value };
};

const schemaIssuesFromToolError = (
  error: ToolError,
): ToolRejectedDiagnostics["schemaIssues"] | undefined => {
  const cause = error.cause;
  if (!Predicate.isRecord(cause) || !Array.isArray(cause.schemaIssues)) return undefined;
  const issues = cause.schemaIssues.filter(
    (issue): issue is { readonly path: string; readonly issue: string } =>
      Predicate.isRecord(issue) &&
      typeof issue.path === "string" &&
      typeof issue.issue === "string",
  );
  return issues.length === 0 ? undefined : issues;
};

const receiptBackedToolBindingReason = (
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

const claimMatchesPreClaim = (
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

const payloadWithToolPreClaim = (
  contract: BoundaryContract,
  kind: string,
  payload: unknown,
  claim: PreClaim,
): unknown => {
  const claimContract = contract.events[kind]?.claim;
  if (claimContract?.phase !== "pre") return payload;
  return Predicate.isRecord(payload) ? { ...payload, [claimContract.key]: claim } : payload;
};

const runtimeToolContext = (
  spec: InternalSubmitSpec,
  boundaryEvents: Context.Tag.Service<typeof BoundaryEvents>,
  projections: Context.Tag.Service<typeof MaterializedProjections>,
  claim: PreClaim,
  resume: unknown,
): ToolExecutionContextInput => {
  const declaredIntents = new Map((spec.toolIntents ?? []).map((intent) => [intent.kind, intent]));
  return {
    ...spec.toolContext,
    ...(resume === undefined ? {} : { resume }),
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
        Effect.map((row) => ({
          kind: row.kind,
          projectionKind: row.kind,
          identityKey: row.identityKey,
          state: row.state as State,
          updatedEventId: row.updatedEventId,
        })),
        Effect.mapError((cause) => new ToolError({ toolName: "awaitProjection", cause })),
      );
    },
  };
};

const toolBudgetTimeCause = (
  elapsedMs: number,
  maxMs: number,
): { readonly reason: "budget_time"; readonly elapsedMs: number; readonly maxMs: number } => ({
  reason: "budget_time",
  elapsedMs,
  maxMs,
});

const isToolBudgetTimeError = (error: ToolError): boolean => {
  const cause = error.cause;
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { readonly reason?: unknown }).reason === "budget_time"
  );
};

const toolBudgetTimePayload = (
  error: ToolError,
): { readonly elapsedMs: number; readonly maxMs: number } => {
  const cause = error.cause as { readonly elapsedMs?: unknown; readonly maxMs?: unknown };
  return {
    elapsedMs: typeof cause.elapsedMs === "number" ? cause.elapsedMs : 0,
    maxMs: typeof cause.maxMs === "number" ? cause.maxMs : 0,
  };
};

export const buildInitialMessages = (
  spec: Pick<InternalSubmitSpec, "system" | "intent" | "context">,
): Effect.Effect<ReadonlyArray<LlmMessage>, JsonStringifyError> =>
  Effect.gen(function* () {
    const ctxStr = yield* safeStringifyPretty(spec.context);
    const systemContent =
      spec.system !== undefined
        ? `${spec.system}\n\nContext available:\n${ctxStr}`
        : `You are an agent. Goal: ${spec.intent}\n\nContext available:\n${ctxStr}\n\nUse the provided tools when needed. Reply with a final natural-language answer when you have enough information.`;
    return [
      { role: "system", content: systemContent },
      { role: "user", content: spec.intent },
    ] satisfies ReadonlyArray<LlmMessage>;
  });

const logRuntimeLedgerEvent = (
  ledger: {
    readonly commit: (
      events: ReadonlyArray<LedgerCommitEventSpec>,
    ) => Effect.Effect<ReadonlyArray<LedgerEvent>, SqlError | JsonStringifyError>;
  },
  spec: RuntimeEventCommitSpec,
): Effect.Effect<LedgerEvent, SqlError | JsonStringifyError> =>
  Effect.gen(function* () {
    const events = yield* ledger.commit([spec]);
    const event = events[0];
    if (event === undefined) {
      return yield* Effect.fail(
        new SqlError({ cause: new Error("ledger commit returned no events for single log") }),
      );
    }
    return event;
  });

const submitResultFromEvents = (
  events: ReadonlyArray<LedgerEvent>,
  runId: number,
): Effect.Effect<SubmitResult, SqlError> => {
  const result = projectSubmitResult(events, runId);
  if (result !== null) return Effect.succeed(result);
  return Effect.fail(
    new SqlError({
      cause: {
        reason: "missing_terminal_ledger_fact",
        runId,
      },
    }),
  );
};

const interruptedSubmitResultFromEvents = (
  events: ReadonlyArray<LedgerEvent>,
  runId: number,
  spec: {
    readonly interruptId: string;
    readonly turn: TurnRef;
    readonly gateRef: string;
    readonly tokensUsed: number;
  },
): SubmitResult => ({
  ok: false,
  status: "interrupted",
  runId,
  reason: "interrupted",
  eventCount: events.length,
  tokensUsed: spec.tokensUsed,
  interruptId: spec.interruptId,
  turn: spec.turn,
  gateRef: spec.gateRef,
});

const decisionInterruptFor = (
  spec: InternalSubmitSpec,
  toolName: string,
): SubmitDecisionInterrupt | undefined =>
  spec.decisionInterrupts?.find((interrupt) => interrupt.toolName === toolName);

const refSuffixFor = (operationRef: string): string => encodeURIComponent(operationRef);

const decisionGateRefFor = (interrupt: SubmitDecisionInterrupt, operationRef: string): string =>
  `${interrupt.gateRefPrefix ?? "decision_gate"}:${refSuffixFor(operationRef)}`;

const decisionInterruptIdFor = (interrupt: SubmitDecisionInterrupt, operationRef: string): string =>
  `${interrupt.interruptIdPrefix ?? "decision"}:${refSuffixFor(operationRef)}`;

const decisionSubjectRefFor = (claim: { readonly operationRef: string }): string =>
  claim.operationRef;

const materialRejection = (
  claim: { readonly operationRef: string },
  reason: string,
  kind: RejectionRef["rejectionKind"] = "resource_denied",
): RejectionRef => ({
  rejectionId: claim.operationRef,
  rejectionKind: kind,
  reason,
});

const resolveToolMaterials = (
  refs: ResolvedMaterialService,
  spec: InternalSubmitSpec,
  tool: Tool,
  claim: { readonly operationRef: string },
): Effect.Effect<
  | {
      readonly ok: true;
      readonly materials: ResolvedToolMaterials;
    }
  | {
      readonly ok: false;
      readonly rejectionRef: RejectionRef;
    },
  never
> =>
  Effect.gen(function* () {
    const out: Record<string, ResolvedMaterial> = {};
    for (const requirement of tool.contract.requiredMaterials) {
      const ref = spec.materials?.[requirement.slot];
      if (ref === undefined) {
        if (requirement.required) {
          return {
            ok: false,
            rejectionRef: materialRejection(
              claim,
              `material_missing:${requirement.slot}`,
              "resource_denied",
            ),
          };
        }
        continue;
      }
      if (!isMaterialRef(ref)) {
        return {
          ok: false,
          rejectionRef: materialRejection(
            claim,
            `material_invalid:${requirement.slot}`,
            "validation_failed",
          ),
        };
      }
      if (!materialRefSatisfiesRequirement(ref, requirement)) {
        return {
          ok: false,
          rejectionRef: materialRejection(
            claim,
            `material_invalid:${requirement.slot}:${materialRefKey(ref)}`,
            "validation_failed",
          ),
        };
      }
      const runResolved = spec.resolvedMaterials?.[requirement.slot];
      if (runResolved !== undefined && runResolved !== null) {
        out[requirement.slot] = runResolved;
        continue;
      }
      const resolved = yield* Effect.either(refs.material(ref));
      if (resolved._tag === "Left") {
        return {
          ok: false,
          rejectionRef: materialRejection(
            claim,
            `material_unresolved:${requirement.slot}:${materialRefKey(ref)}`,
            "resource_denied",
          ),
        };
      }
      out[requirement.slot] = resolved.right;
    }
    return { ok: true, materials: out };
  });

const payloadRecord = (event: LedgerEvent): Readonly<Record<string, unknown>> | null =>
  Predicate.isRecord(event.payload) ? event.payload : null;

const matchingDecisionEvent = (
  events: ReadonlyArray<LedgerEvent>,
  gateRef: string,
  decisionRef: string,
): LedgerEvent | undefined =>
  events.find((event) => {
    const payload = payloadRecord(event);
    return (
      event.kind === DECISION_GATE_KIND.DECIDED &&
      payload?.gateRef === gateRef &&
      payload.decisionRef === decisionRef
    );
  });

const matchingInterruptionEvent = (
  events: ReadonlyArray<LedgerEvent>,
  resume: NonNullable<InternalSubmitSpec["resume"]>,
): LedgerEvent | undefined =>
  events.find((event) => {
    const decoded = decodeRuntimeLedgerEvent(event);
    return (
      decoded._tag === "runtime" &&
      decoded.event.kind === RUNTIME_EVENT_KIND.AGENT_RUN_INTERRUPTED &&
      decoded.event.payload.runId === resume.runId &&
      decoded.event.payload.turn.id === resume.turn.id &&
      decoded.event.payload.turn.index === resume.turn.index &&
      decoded.event.payload.interruptId === resume.interruptId &&
      decoded.event.payload.decision?.gateRef === resume.gateRef
    );
  });

const replayMessagesToInterruptedTool = (
  initialMessages: ReadonlyArray<LlmMessage>,
  events: ReadonlyArray<LedgerEvent>,
  resume: NonNullable<InternalSubmitSpec["resume"]>,
  interruptedToolCallId: string,
  executionDomains: ReadonlyArray<ExecutionDomainDeclaration>,
): Effect.Effect<
  {
    readonly messages: LlmMessage[];
    readonly call: LlmToolCall;
  },
  SqlError | JsonStringifyError
> =>
  Effect.gen(function* () {
    const messages: LlmMessage[] = [...initialMessages];

    for (let index = 0; index <= resume.turn.index; index++) {
      const llmEvent = events.find((event) => {
        const decoded = decodeRuntimeLedgerEvent(event);
        return (
          decoded._tag === "runtime" &&
          decoded.event.kind === RUNTIME_EVENT_KIND.LLM_RESPONSE &&
          decoded.event.payload.turn.id === resume.runId &&
          decoded.event.payload.turn.index === index
        );
      });
      if (llmEvent === undefined) {
        return yield* Effect.fail(
          new SqlError({
            cause: {
              reason: "resume_missing_llm_turn",
              runId: resume.runId,
              turnIndex: index,
            },
          }),
        );
      }

      const decoded = decodeRuntimeLedgerEvent(llmEvent);
      if (decoded._tag !== "runtime" || decoded.event.kind !== RUNTIME_EVENT_KIND.LLM_RESPONSE) {
        return yield* Effect.fail(new SqlError({ cause: { reason: "resume_bad_llm_turn" } }));
      }
      const responseText = textFromLlmOutputItems(decoded.event.payload.items);
      const responseToolCalls = toolCallsFromLlmOutputItems(decoded.event.payload.items);
      messages.push({
        role: "assistant",
        content: responseText,
        tool_calls: responseToolCalls.length > 0 ? responseToolCalls : undefined,
      });

      for (const call of responseToolCalls) {
        if (index === resume.turn.index && call.id === interruptedToolCallId) {
          return { messages, call };
        }

        const toolEvent = events.find((event) => {
          const decodedTool = decodeRuntimeLedgerEvent(event);
          return (
            decodedTool._tag === "runtime" &&
            decodedTool.event.kind === RUNTIME_EVENT_KIND.TOOL_EXECUTED &&
            decodedTool.event.payload.runId === resume.runId &&
            decodedTool.event.payload.toolCallId === call.id
          );
        });
        if (toolEvent === undefined) continue;
        const decodedTool = decodeRuntimeLedgerEvent(toolEvent);
        if (
          decodedTool._tag === "runtime" &&
          decodedTool.event.kind === RUNTIME_EVENT_KIND.TOOL_EXECUTED
        ) {
          const resolvedExecution = resolveToolExecution(decodedTool.event.payload.execution, {
            domains: executionDomains,
          });
          if (!resolvedExecution.ok) {
            return yield* Effect.fail(
              new SqlError({
                cause: {
                  reason: "tool_execution_witness_resolution_failed",
                  issues: resolvedExecution.issues,
                  runId: resume.runId,
                  toolCallId: call.id,
                  toolName: call.function.name,
                },
              }),
            );
          }
          const artifact = toolReplayArtifactFromExecutedPayload(
            decodedTool.event.payload,
            resolvedExecution.resolved,
          );
          if (!artifact.ok) {
            return yield* Effect.fail(
              new SqlError({
                cause: {
                  reason: artifact.reason,
                  runId: resume.runId,
                  toolCallId: call.id,
                  toolName: call.function.name,
                },
              }),
            );
          }
          const replayed = replayToolFromArtifact(artifact.artifact);
          const resultStr = yield* safeStringify(replayed.result);
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            name: call.function.name,
            content: resultStr,
          });
        }
      }
    }

    return yield* Effect.fail(
      new SqlError({
        cause: {
          reason: "resume_missing_interrupted_tool_call",
          runId: resume.runId,
          interruptId: resume.interruptId,
        },
      }),
    );
  });

/** The single termination funnel. All recoverable aborts route through here.
 *  Logs an agent.aborted.* ledger event then constructs SubmitResult.fail. */
const finalAbort = (
  kind: AbortKind,
  payload: Record<string, unknown>,
  identity: LedgerTruthIdentity,
  runId: number,
  tokensUsed: number,
  traceContext?: TraceContext,
): Effect.Effect<SubmitResult, SqlError | JsonStringifyError, Ledger> =>
  Effect.gen(function* () {
    const ledger = yield* Ledger;
    yield* logRuntimeLedgerEvent(
      ledger,
      agentRunAbortedEvent({ ...identity, kind, runId, tokensUsed, payload, traceContext }),
    );
    const events = yield* ledger.events(identity);
    return yield* submitResultFromEvents(events, runId);
  });

const llmTimeoutFor = (
  startTime: number,
  now: number,
  budgetTimeMs: number,
):
  | {
      readonly ok: true;
      readonly mode: "budget" | "provider";
      readonly timeoutMs: number;
    }
  | {
      readonly ok: false;
      readonly elapsedMs: number;
    } => {
  const elapsedMs = now - startTime;
  if (Number.isFinite(budgetTimeMs)) {
    const remaining = budgetTimeMs - elapsedMs;
    if (remaining <= 0) return { ok: false, elapsedMs };
    return { ok: true, mode: "budget", timeoutMs: remaining };
  }
  return { ok: true, mode: "provider", timeoutMs: DEFAULT_LLM_CALL_TIMEOUT_MS };
};

const timeoutAbortResult = (
  timeout: LlmCallTimedOut,
  identity: LedgerTruthIdentity,
  runId: number,
  tokensUsed: number,
  traceContext?: TraceContext,
): Effect.Effect<SubmitResult, SqlError | JsonStringifyError, Ledger> => {
  if (timeout.mode === "budget") {
    return finalAbort(
      ABORT.BUDGET_TIME,
      { elapsedMs: timeout.elapsedMs, maxMs: timeout.timeoutMs },
      identity,
      runId,
      tokensUsed,
      traceContext,
    );
  }
  return finalAbort(
    ABORT.UPSTREAM_FAILURE,
    { cause: "provider_timeout", timeoutMs: timeout.timeoutMs },
    identity,
    runId,
    tokensUsed,
    traceContext,
  );
};

const isLlmCallTimedOut = (error: unknown): error is LlmCallTimedOut =>
  error instanceof LlmCallTimedOut;

export const submitAgentEffect = (
  spec: InternalSubmitSpec,
): Effect.Effect<
  SubmitResult,
  | SqlError
  | JsonStringifyError
  | InvalidTraceContext
  | RefResolutionFailed
  | BoundaryCommitRejected,
  | Ledger
  | BoundaryEvents
  | MaterializedProjections
  | LlmTransport
  | Quota
  | Admission
  | RefResolverService
> =>
  Effect.gen(function* () {
    const ledger = yield* Ledger;
    const traceContextResult = validateOptionalTraceContext(spec.traceContext);
    if (!traceContextResult.ok) {
      return yield* Effect.fail(
        new InvalidTraceContext({
          position: "submit",
          reason: traceContextResult.reason,
        }),
      );
    }
    const traceContext = copyTraceContext(traceContextResult.traceContext);
    const startTime = yield* Clock.currentTimeMillis;
    const budgetTokens = spec.budget?.tokens ?? Number.POSITIVE_INFINITY;
    const budgetTimeMs = spec.budget?.timeMs ?? Number.POSITIVE_INFINITY;
    const maxTurns = spec.budget?.maxTurns ?? 5;
    const toolRetries = Math.max(0, spec.budget?.toolRetries ?? 2);
    const scope = spec.scope;
    const scopeRef = spec.scopeRef;
    const identity = {
      scopeRef,
      effectAuthorityRef: spec.effectAuthorityRef,
    } satisfies LedgerTruthIdentity;

    if (spec.resume !== undefined && spec.resume.turn.id !== spec.resume.runId) {
      return yield* Effect.fail(
        new SqlError({
          cause: {
            reason: "resume_turn_run_mismatch",
            runId: spec.resume.runId,
            turn: spec.resume.turn,
          },
        }),
      );
    }

    const priorEvents = spec.resume === undefined ? [] : yield* ledger.events(identity);
    const started =
      spec.resume === undefined
        ? yield* logRuntimeLedgerEvent(
            ledger,
            agentRunStartedEvent({ ...identity, intent: spec.intent, traceContext }),
          )
        : priorEvents.find(
            (event) =>
              event.id === spec.resume?.runId &&
              event.kind === RUNTIME_EVENT_KIND.AGENT_RUN_STARTED,
          );
    if (started === undefined) {
      return yield* Effect.fail(
        new SqlError({
          cause: {
            reason: "resume_missing_run_started",
            runId: spec.resume?.runId,
          },
        }),
      );
    }
    if (spec.resume === undefined) {
      yield* logRuntimeLedgerEvent(
        ledger,
        chatIngestedEvent({
          ...identity,
          runId: started.id,
          intent: spec.intent,
          context: spec.context,
          traceContext,
        }),
      );
    } else {
      const existingTerminal = projectSubmitResult(priorEvents, started.id);
      if (existingTerminal !== null) return existingTerminal;
    }

    const tokensUsedRef = yield* Ref.make(0);
    // ====================================================================
    // Spec-25 short path: structured-output submit (one-shot, no loop).
    //
    // outputSchema present → bypass the multi-turn tool loop entirely.
    // attemptStructured handles the admission gate (lease cache), provider
    // call, decode, and evidence emission. Submit owns token budget,
    // completion, and terminal run facts.
    // ====================================================================
    if (spec.outputSchema !== undefined) {
      if (spec.resume !== undefined) {
        return yield* finalAbort(
          ABORT.UPSTREAM_FAILURE,
          { reason: "output_schema_excludes_resume_in_v0_2_10" },
          identity,
          started.id,
          0,
          traceContext,
        );
      }
      if (Object.keys(spec.tools).length > 0) {
        return yield* finalAbort(
          ABORT.UPSTREAM_FAILURE,
          {
            reason: "output_schema_excludes_tools_in_v0_2_10",
            toolCount: Object.keys(spec.tools).length,
          },
          identity,
          started.id,
          0,
          traceContext,
        );
      }

      const admission = yield* Admission;
      const schemaSpec = yield* makeAdmissionSchemaSpec(spec.outputSchema);
      const route: LlmRoute = spec.route;

      const ctxStr = yield* safeStringifyPretty(spec.context);
      const userText = `${spec.intent}\n\nContext:\n${ctxStr}`;
      const beforeCall = yield* Clock.currentTimeMillis;
      const tokensBeforeCall = yield* Ref.get(tokensUsedRef);
      const timeout = llmTimeoutFor(startTime, beforeCall, budgetTimeMs);
      if (!timeout.ok) {
        return yield* finalAbort(
          ABORT.BUDGET_TIME,
          { elapsedMs: timeout.elapsedMs, maxMs: budgetTimeMs },
          identity,
          started.id,
          tokensBeforeCall,
          traceContext,
        );
      }
      const controller = new AbortController();
      const attempted = yield* Effect.either(
        admission
          .attemptStructured<unknown>({
            scope,
            route,
            schemaSpec,
            strategy: "forced-tool-call",
            traceContext,
            signal: controller.signal,
            stimulus: {
              kind: "live",
              userInput: { userText },
            },
          })
          .pipe(
            Effect.timeoutFail({
              duration: Duration.millis(timeout.timeoutMs),
              onTimeout: () => {
                controller.abort("agent_os.llm_call_timeout");
                return new LlmCallTimedOut({
                  mode: timeout.mode,
                  elapsedMs: timeout.mode === "budget" ? budgetTimeMs : timeout.timeoutMs,
                  timeoutMs: timeout.mode === "budget" ? budgetTimeMs : timeout.timeoutMs,
                });
              },
            }),
          ),
      );
      if (attempted._tag === "Left") {
        if (isLlmCallTimedOut(attempted.left)) {
          return yield* timeoutAbortResult(
            attempted.left,
            identity,
            started.id,
            tokensBeforeCall,
            traceContext,
          );
        }
        if (attempted.left._tag === ABORT.UPSTREAM_FAILURE) {
          return yield* finalAbort(
            ABORT.UPSTREAM_FAILURE,
            { cause: publicRuntimeCauseReason(attempted.left.cause) },
            identity,
            started.id,
            tokensBeforeCall,
            traceContext,
          );
        }
        return yield* Effect.fail(attempted.left);
      }
      const result = attempted.right;

      if (result.ok) {
        const tokens = result.outcome.class === "Supported" ? result.outcome.tokensUsed : 0;
        yield* Ref.set(tokensUsedRef, tokens);
        if (tokens > budgetTokens) {
          return yield* finalAbort(
            ABORT.BUDGET_TOKENS,
            { tokensUsed: tokens, tokensMax: budgetTokens },
            identity,
            started.id,
            tokens,
            traceContext,
          );
        }
        const finalStr = yield* safeStringify(result.decoded);
        yield* ledger.commit([
          agentRunCompletedEvent({
            ...identity,
            runId: started.id,
            final: finalStr,
            output: result.decoded,
            outputKind: "json",
            tokensUsed: tokens,
            traceContext,
          }),
        ]);
        const events = yield* ledger.events(identity);
        return yield* submitResultFromEvents(events, started.id);
      }

      // attemptStructured returned a non-Supported outcome. Funnel
      // through finalAbort so the abort taxonomy stays stable (no new
      // ABORT kind for v0.2.10).
      return yield* finalAbort(
        ABORT.UPSTREAM_FAILURE,
        {
          reason: "structured_output_failed",
          outcomeClass: result.outcome.class,
          shortCircuited: result.shortCircuited,
          admissionImpact: result.admissionImpact,
          lease: result.lease,
        },
        identity,
        started.id,
        0,
        traceContext,
      );
    }

    // ====================================================================
    // Spec-24 standard path: multi-turn tool loop.
    // ====================================================================

    const registry = validateToolRegistry(spec.tools);
    if (!registry.ok) {
      return yield* finalAbort(
        ABORT.TOOL_ERROR,
        {
          reason: "invalid_tool_registry",
          issues: registry.issues,
        },
        identity,
        started.id,
        0,
        traceContext,
      );
    }
    const domainRegistry = validateExecutionDomainRegistry(spec.tools, {
      domains: spec.executionDomains ?? [],
    });
    if (!domainRegistry.ok) {
      return yield* finalAbort(
        ABORT.TOOL_ERROR,
        {
          reason: "invalid_execution_domain_registry",
          issues: domainRegistry.issues,
        },
        identity,
        started.id,
        0,
        traceContext,
      );
    }

    const initialMessages = yield* buildInitialMessages(spec);

    const loop: Effect.Effect<
      SubmitResult,
      | SqlError
      | JsonStringifyError
      | UpstreamFailure
      | ToolError
      | RefResolutionFailed
      | BoundaryCommitRejected,
      Ledger | BoundaryEvents | MaterializedProjections | LlmTransport | Quota | RefResolverService
    > = Effect.gen(function* () {
      let messages: LlmMessage[] = [...initialMessages];
      const toolDefs = toolDefinitionsOf(spec.tools);
      const quotaService = yield* Quota;
      const llm = yield* LlmTransport;
      const boundaryEvents = yield* BoundaryEvents;
      const projections = yield* MaterializedProjections;
      const refs = yield* RefResolverService;
      let firstTurn = 0;
      let resumedToolCall: LlmToolCall | undefined;

      if (spec.resume !== undefined) {
        const interruption = matchingInterruptionEvent(priorEvents, spec.resume);
        if (interruption === undefined) {
          return yield* finalAbort(
            ABORT.TOOL_ERROR,
            {
              reason: "resume_missing_matching_interruption",
              interruptId: spec.resume.interruptId,
              gateRef: spec.resume.gateRef,
            },
            identity,
            started.id,
            0,
            traceContext,
          );
        }
        const decodedInterruption = decodeRuntimeLedgerEvent(interruption);
        const decision =
          decodedInterruption._tag === "runtime" &&
          decodedInterruption.event.kind === RUNTIME_EVENT_KIND.AGENT_RUN_INTERRUPTED
            ? decodedInterruption.event.payload.decision
            : undefined;
        if (decision === undefined) {
          return yield* finalAbort(
            ABORT.TOOL_ERROR,
            {
              reason: "resume_interruption_missing_decision_binding",
              interruptId: spec.resume.interruptId,
            },
            identity,
            started.id,
            0,
            traceContext,
          );
        }

        const projection = projectDecisionGate(priorEvents, spec.resume.gateRef);
        if (
          projection.status !== "approved" ||
          projection.decision?.decisionRef !== spec.resume.decisionRef ||
          projection.request === undefined
        ) {
          return yield* finalAbort(
            ABORT.TOOL_ERROR,
            {
              reason:
                projection.status === "consumed"
                  ? "decision_gate_consumed"
                  : projection.status === "rejected"
                    ? "decision_gate_rejected"
                    : "decision_gate_not_approved",
              gateRef: spec.resume.gateRef,
              decisionRef: spec.resume.decisionRef,
              status: projection.status,
            },
            identity,
            started.id,
            0,
            traceContext,
          );
        }
        const decisionEvent = matchingDecisionEvent(
          priorEvents,
          spec.resume.gateRef,
          spec.resume.decisionRef,
        );
        if (decisionEvent === undefined) {
          return yield* finalAbort(
            ABORT.TOOL_ERROR,
            {
              reason: "decision_gate_approved_without_decision_event",
              gateRef: spec.resume.gateRef,
              decisionRef: spec.resume.decisionRef,
            },
            identity,
            started.id,
            0,
            traceContext,
          );
        }

        const replayed = yield* replayMessagesToInterruptedTool(
          initialMessages,
          priorEvents,
          spec.resume,
          decision.toolCallId,
          spec.executionDomains ?? [],
        );
        messages = replayed.messages;
        resumedToolCall = replayed.call;
        firstTurn = spec.resume.turn.index;
        const priorTokens = priorEvents.reduce((sum, event) => {
          const decoded = decodeRuntimeLedgerEvent(event);
          return decoded._tag === "runtime" &&
            decoded.event.kind === RUNTIME_EVENT_KIND.LLM_RESPONSE &&
            decoded.event.payload.turn.id === spec.resume?.runId
            ? sum + decoded.event.payload.usage.totalTokens
            : sum;
        }, 0);
        yield* Ref.set(tokensUsedRef, priorTokens);

        const consumed = yield* boundaryEvents.commit(
          decisionGateBoundaryContract,
          DECISION_GATE_KIND.CONSUMED,
          {
            gateRef: spec.resume.gateRef,
            decisionRef: spec.resume.decisionRef,
            consumedBy: `agent.run:${spec.resume.runId}`,
            claim: settleDecisionGateConsumed(projection.request.claim, {
              gateRef: spec.resume.gateRef,
              eventId: decisionEvent.id,
            }),
          },
        );
        yield* logRuntimeLedgerEvent(
          ledger,
          agentRunResumedEvent({
            ...identity,
            runId: spec.resume.runId,
            turn: spec.resume.turn,
            interruptId: spec.resume.interruptId,
            resume: spec.resume.resume,
            resumedAtEventId: consumed.id,
            traceContext,
          }),
        );
      }

      for (let turn = firstTurn; turn < maxTurns; turn++) {
        const now = yield* Clock.currentTimeMillis;
        const tokensBeforeCall = yield* Ref.get(tokensUsedRef);

        const resumedThisTurn = resumedToolCall;
        resumedToolCall = undefined;
        const resumedToolCallIdThisTurn = resumedThisTurn?.id;
        const responseToolCalls: LlmToolCall[] =
          resumedThisTurn === undefined ? [] : [resumedThisTurn];
        let newTokens = tokensBeforeCall;

        if (resumedThisTurn === undefined) {
          const timeout = llmTimeoutFor(startTime, now, budgetTimeMs);
          if (!timeout.ok) {
            return yield* finalAbort(
              ABORT.BUDGET_TIME,
              { elapsedMs: timeout.elapsedMs, maxMs: budgetTimeMs },
              identity,
              started.id,
              tokensBeforeCall,
              traceContext,
            );
          }

          const controller = new AbortController();
          const timedResp = yield* Effect.either(
            llm
              .call(
                {
                  route: spec.route,
                  messages,
                  tools: toolDefs.length > 0 ? toolDefs : undefined,
                  traceContext,
                },
                { signal: controller.signal },
              )
              .pipe(
                Effect.timeoutFail({
                  duration: Duration.millis(timeout.timeoutMs),
                  onTimeout: () => {
                    controller.abort("agent_os.llm_call_timeout");
                    return new LlmCallTimedOut({
                      mode: timeout.mode,
                      elapsedMs: timeout.mode === "budget" ? budgetTimeMs : timeout.timeoutMs,
                      timeoutMs: timeout.mode === "budget" ? budgetTimeMs : timeout.timeoutMs,
                    });
                  },
                }),
              ),
          );
          if (timedResp._tag === "Left") {
            if (isLlmCallTimedOut(timedResp.left)) {
              return yield* timeoutAbortResult(
                timedResp.left,
                identity,
                started.id,
                tokensBeforeCall,
                traceContext,
              );
            }
            return yield* Effect.fail(timedResp.left);
          }
          const resp = timedResp.right;
          const nextResponseText = textFromLlmOutputItems(resp.items);
          const nextResponseToolCalls = toolCallsFromLlmOutputItems(resp.items);

          newTokens = tokensBeforeCall + resp.usage.totalTokens;
          yield* Ref.set(tokensUsedRef, newTokens);

          yield* logRuntimeLedgerEvent(
            ledger,
            llmResponseEvent({
              ...identity,
              turn: turnRefOf(started.id, turn),
              items: resp.items,
              usage: resp.usage,
              traceContext,
            }),
          );

          if (newTokens > budgetTokens) {
            return yield* finalAbort(
              ABORT.BUDGET_TOKENS,
              { tokensUsed: newTokens, tokensMax: budgetTokens },
              identity,
              started.id,
              newTokens,
              traceContext,
            );
          }

          messages.push({
            role: "assistant",
            content: nextResponseText,
            tool_calls: nextResponseToolCalls.length > 0 ? nextResponseToolCalls : undefined,
          });

          if (nextResponseToolCalls.length === 0) {
            yield* ledger.commit([
              agentRunCompletedEvent({
                ...identity,
                runId: started.id,
                final: nextResponseText,
                output: nextResponseText,
                outputKind: "text",
                tokensUsed: newTokens,
                turn: turnRefOf(started.id, turn),
                traceContext,
              }),
            ]);
            const events = yield* ledger.events(identity);
            return yield* submitResultFromEvents(events, started.id);
          }

          responseToolCalls.push(...nextResponseToolCalls);
        }

        if (newTokens > budgetTokens) {
          return yield* finalAbort(
            ABORT.BUDGET_TOKENS,
            { tokensUsed: newTokens, tokensMax: budgetTokens },
            identity,
            started.id,
            newTokens,
            traceContext,
          );
        }

        for (const call of responseToolCalls) {
          // Parse OUTSIDE the retry block. unknown_tool / invalid_args are
          // non-recoverable: retrying the same args won't make them valid,
          // AND parsing before any quota grant means invalid LLM-emitted
          // args never consume quota.
          const tool = spec.tools[call.function.name];
          if (tool === undefined) {
            return yield* new ToolError({
              toolName: call.function.name,
              cause: { reason: "unknown_tool" },
            });
          }
          const contract = tool.contract;
          // O-2: LLM-emitted tool arguments are not reproducible idempotency
          // material; this concrete call attempt is the semantic effect.
          const claim = makePreClaim({
            operationRef: makeOperationRef("tool", [scope, started.id, turn, call.id]),
            scopeRef,
            effectAuthorityRef: contract.effectAuthorityRef,
            originRef: contract.originRef ?? {
              originId: `run:${started.id}`,
              originKind: "submit",
            },
          });
          const parsed = yield* Effect.either(
            Effect.try({
              try: () => JSON.parse(call.function.arguments) as unknown,
              catch: (cause) =>
                new ToolError({
                  toolName: call.function.name,
                  cause: {
                    reason: "invalid_args",
                    parseError: cause instanceof Error ? cause.name : typeof cause,
                  },
                }),
            }),
          );
          if (parsed._tag === "Left") {
            yield* logRuntimeLedgerEvent(
              ledger,
              toolRejectedEvent({
                ...identity,
                runId: started.id,
                toolCallId: call.id,
                name: call.function.name,
                args: summarizeToolArguments(call.function.arguments),
                execution: tool.execution,
                claim: settleToolValidationRejected(claim, "invalid_args"),
                diagnostics: {
                  phase: "parse",
                  reason: "invalid_args",
                  argumentSummary: summarizeToolArguments(call.function.arguments),
                },
                traceContext,
              }),
            );
            return yield* parsed.left;
          }
          const decoded = yield* Effect.either(
            decodeToolArgs(tool, parsed.right, call.function.name),
          );
          if (decoded._tag === "Left") {
            const schemaIssues = schemaIssuesFromToolError(decoded.left);
            yield* logRuntimeLedgerEvent(
              ledger,
              toolRejectedEvent({
                ...identity,
                runId: started.id,
                toolCallId: call.id,
                name: call.function.name,
                args: summarizeToolArguments(parsed.right),
                execution: tool.execution,
                claim: settleToolValidationRejected(claim, "invalid_args"),
                diagnostics: {
                  phase: "decode",
                  reason: "invalid_args",
                  argumentSummary: summarizeToolArguments(parsed.right),
                  ...(schemaIssues === undefined ? {} : { schemaIssues }),
                },
                traceContext,
              }),
            );
            return yield* decoded.left;
          }
          const args = decoded.right;

          const interrupt = decisionInterruptFor(spec, call.function.name);
          if (interrupt !== undefined && call.id !== resumedToolCallIdThisTurn) {
            const gateRef = decisionGateRefFor(interrupt, claim.operationRef);
            const interruptId = decisionInterruptIdFor(interrupt, claim.operationRef);
            const subjectRef = decisionSubjectRefFor(claim);
            yield* boundaryEvents.commit(
              decisionGateBoundaryContract,
              DECISION_GATE_KIND.REQUESTED,
              {
                gateRef,
                subjectRef,
                ...(interrupt.policyRef === undefined ? {} : { policyRef: interrupt.policyRef }),
                ...(interrupt.summary === undefined ? {} : { summary: interrupt.summary }),
                claim,
              },
            );
            yield* logRuntimeLedgerEvent(
              ledger,
              agentRunInterruptedEvent({
                ...identity,
                runId: started.id,
                turn: turnRefOf(started.id, turn),
                interruptId,
                reason: interrupt.reason,
                resumeSchema: interrupt.resumeSchema ?? {},
                tokensUsed: newTokens,
                decision: {
                  gateRef,
                  subjectRef,
                  toolCallId: call.id,
                  toolName: call.function.name,
                },
                traceContext,
              }),
            );
            const events = yield* ledger.events(identity);
            return interruptedSubmitResultFromEvents(events, started.id, {
              interruptId,
              turn: turnRefOf(started.id, turn),
              gateRef,
              tokensUsed: newTokens,
            });
          }

          const resolvedMaterials = yield* resolveToolMaterials(refs, spec, tool, claim);
          if (!resolvedMaterials.ok) {
            yield* logRuntimeLedgerEvent(
              ledger,
              toolRejectedEvent({
                ...identity,
                runId: started.id,
                toolCallId: call.id,
                name: call.function.name,
                args: call.function.arguments,
                execution: tool.execution,
                claim: settleToolAdmissionRejected(claim, resolvedMaterials.rejectionRef),
                traceContext,
              }),
            );
            return yield* new ToolError({
              toolName: call.function.name,
              cause: toolAdmissionFailureCause(resolvedMaterials.rejectionRef),
            });
          }

          const admissionProgram = yield* Effect.either(
            Effect.try({
              try: () =>
                tool.admit({
                  claim,
                  args,
                  contract,
                  execution: tool.execution,
                  toolName: call.function.name,
                }),
              catch: (cause): RejectionRef => admitterErrorRejectionRef(claim, cause),
            }),
          );
          const admission =
            admissionProgram._tag === "Left"
              ? {
                  ok: false as const,
                  rejectionRef: admissionProgram.left,
                }
              : yield* admissionProgram.right.pipe(
                  Effect.catchAll((cause) =>
                    Effect.succeed({
                      ok: false as const,
                      rejectionRef: admitterErrorRejectionRef(claim, cause),
                    }),
                  ),
                );
          const normalizedAdmission = normalizeAdmitVerdict(claim, admission);
          const rejectedAdmission =
            normalizedAdmission.ok === false ? normalizedAdmission.rejectionRef : null;
          if (rejectedAdmission !== null) {
            yield* logRuntimeLedgerEvent(
              ledger,
              toolRejectedEvent({
                ...identity,
                runId: started.id,
                toolCallId: call.id,
                name: call.function.name,
                args: call.function.arguments,
                execution: tool.execution,
                claim: settleToolAdmissionRejected(claim, rejectedAdmission),
                traceContext,
              }),
            );
            return yield* new ToolError({
              toolName: call.function.name,
              cause: toolAdmissionFailureCause(rejectedAdmission),
            });
          }

          const resolvedExecution = resolveToolExecution(tool.execution, {
            domains: spec.executionDomains ?? [],
          });
          if (!resolvedExecution.ok) {
            return yield* new ToolError({
              toolName: call.function.name,
              cause: {
                reason: "tool_execution_witness_resolution_failed",
                issues: resolvedExecution.issues,
              },
            });
          }

          const receiptBindingReason =
            resolvedExecution.resolved.witness === "receipt"
              ? receiptBackedToolBindingReason(spec, call.function.name)
              : null;
          if (receiptBindingReason !== null) {
            yield* logRuntimeLedgerEvent(
              ledger,
              toolRejectedEvent({
                ...identity,
                runId: started.id,
                toolCallId: call.id,
                name: call.function.name,
                args: call.function.arguments,
                execution: tool.execution,
                claim: settleToolExecutionRejected(claim, receiptBindingReason),
                traceContext,
              }),
            );
            return yield* new ToolError({
              toolName: call.function.name,
              cause: { reason: receiptBindingReason },
            });
          }

          // Grant + execute are inside retry, but quota grants are keyed by
          // the semantic tool claim operationRef. Retrying the same claim
          // cannot double-charge quota; separate tool calls still consume
          // separate quota.
          const attemptOnce: Effect.Effect<unknown, ToolError | SqlError | JsonStringifyError> =
            Effect.gen(function* () {
              const attempt = Effect.gen(function* () {
                if (tool.quota !== undefined) {
                  const q = tool.quota;
                  const amount = q.amount ?? 1;
                  if (!Number.isFinite(amount) || amount < 0) {
                    return yield* new ToolError({
                      toolName: call.function.name,
                      cause: { reason: "invalid_quota_amount", amount },
                    });
                  }
                  if (!Number.isFinite(q.limit) || q.limit < 0) {
                    return yield* new ToolError({
                      toolName: call.function.name,
                      cause: { reason: "invalid_quota_limit", limit: q.limit },
                    });
                  }
                  // windowMs accepts POSITIVE_INFINITY (unbounded billing
                  // window) but not NaN or negative.
                  const windowOk =
                    q.windowMs === Number.POSITIVE_INFINITY ||
                    (Number.isFinite(q.windowMs) && q.windowMs >= 0);
                  if (!windowOk) {
                    return yield* new ToolError({
                      toolName: call.function.name,
                      cause: { reason: "invalid_quota_window", windowMs: q.windowMs },
                    });
                  }
                  if (q.key !== undefined && q.key.length === 0) {
                    return yield* new ToolError({
                      toolName: call.function.name,
                      cause: { reason: "invalid_quota_key", key: q.key },
                    });
                  }
                  const key = q.key ?? call.function.name;
                  const grant = yield* quotaService.tryGrant(
                    {
                      scopeRef,
                      effectAuthorityRef: contract.effectAuthorityRef,
                    },
                    key,
                    amount,
                    q.windowMs,
                    q.limit,
                    call.function.name,
                    claim.operationRef,
                  );
                  if (!grant.granted) {
                    return yield* new ToolError({
                      toolName: call.function.name,
                      cause: {
                        reason: "rate_limited",
                        key,
                        consumed: grant.consumed,
                        limit: grant.limit,
                      },
                    });
                  }
                }
                return yield* executeTool(
                  tool,
                  args,
                  call.function.name,
                  resolvedMaterials.materials,
                  runtimeToolContext(
                    spec,
                    boundaryEvents,
                    projections,
                    claim,
                    call.id === resumedToolCallIdThisTurn ? spec.resume?.resume : undefined,
                  ),
                );
              });
              if (!Number.isFinite(budgetTimeMs)) {
                return yield* attempt;
              }
              const now = yield* Clock.currentTimeMillis;
              const elapsedMs = now - startTime;
              const remainingMs = budgetTimeMs - elapsedMs;
              if (remainingMs <= 0) {
                return yield* new ToolError({
                  toolName: call.function.name,
                  cause: toolBudgetTimeCause(elapsedMs, budgetTimeMs),
                });
              }
              return yield* attempt.pipe(
                Effect.timeoutFail({
                  duration: Duration.millis(remainingMs),
                  onTimeout: () =>
                    new ToolError({
                      toolName: call.function.name,
                      cause: toolBudgetTimeCause(budgetTimeMs, budgetTimeMs),
                    }),
                }),
              );
            });

          const result = yield* attemptOnce.pipe(
            Effect.retry({
              times: toolRetries,
              while: (err) => {
                // Don't retry rate_limited — quota state doesn't change
                // between immediate retries.
                // Don't retry invalid_quota_* — config error, not transient.
                if (err._tag === ABORT.TOOL_ERROR) {
                  const cause = (err as ToolError).cause;
                  if (typeof cause === "object" && cause !== null) {
                    const reason = (cause as { reason?: unknown }).reason;
                    if (reason === "budget_time") return false;
                    if (reason === "rate_limited") return false;
                    if (typeof reason === "string" && reason.startsWith("invalid_quota_")) {
                      return false;
                    }
                  }
                }
                return true;
              },
            }),
            Effect.catchTags({
              [ABORT.TOOL_ERROR]: (error) =>
                Effect.gen(function* () {
                  const reason = toolErrorReason(error);
                  yield* logRuntimeLedgerEvent(
                    ledger,
                    toolRejectedEvent({
                      ...identity,
                      runId: started.id,
                      toolCallId: call.id,
                      name: call.function.name,
                      args: call.function.arguments,
                      execution: tool.execution,
                      claim: settleToolExecutionRejected(claim, reason),
                      traceContext,
                    }),
                  );
                  return yield* error;
                }),
            }),
          );

          const terminal =
            resolvedExecution.resolved.witness === "receipt"
              ? receiptBackedToolResultFromUnknown(result)
              : null;
          if (resolvedExecution.resolved.witness === "receipt" && terminal === null) {
            yield* logRuntimeLedgerEvent(
              ledger,
              toolRejectedEvent({
                ...identity,
                runId: started.id,
                toolCallId: call.id,
                name: call.function.name,
                args: call.function.arguments,
                execution: tool.execution,
                claim: settleToolExecutionRejected(
                  claim,
                  EXTERNAL_TOOL_EXECUTION_REQUIRES_RECEIPT_REASON,
                ),
                traceContext,
              }),
            );
            return yield* new ToolError({
              toolName: call.function.name,
              cause: { reason: EXTERNAL_TOOL_EXECUTION_REQUIRES_RECEIPT_REASON },
            });
          }
          if (
            terminal !== null &&
            (!claimMatchesPreClaim(terminal.claim, claim) ||
              terminal.receipt.anchorKind !== "external_receipt")
          ) {
            yield* logRuntimeLedgerEvent(
              ledger,
              toolRejectedEvent({
                ...identity,
                runId: started.id,
                toolCallId: call.id,
                name: call.function.name,
                args: call.function.arguments,
                execution: tool.execution,
                claim: settleToolExecutionRejected(claim, "receipt_backed_tool_claim_mismatch"),
                traceContext,
              }),
            );
            return yield* new ToolError({
              toolName: call.function.name,
              cause: { reason: "receipt_backed_tool_claim_mismatch" },
            });
          }

          const toolResult = terminal?.result ?? result;
          const toolClaim = terminal?.claim ?? settleToolExecuted(claim, contract);
          const resultStr = yield* safeStringify(toolResult);
          yield* logRuntimeLedgerEvent(
            ledger,
            toolExecutedEvent({
              ...identity,
              runId: started.id,
              toolCallId: call.id,
              name: call.function.name,
              args: call.function.arguments,
              execution: tool.execution,
              result: toolResult,
              claim: toolClaim,
              traceContext,
            }),
          );
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            name: call.function.name,
            content: resultStr,
          });
        }
      }

      const tokensUsed = yield* Ref.get(tokensUsedRef);
      return yield* finalAbort(
        ABORT.RETRIES,
        { maxTurns },
        identity,
        started.id,
        tokensUsed,
        traceContext,
      );
    });

    return yield* loop.pipe(
      Effect.catchTags({
        [ABORT.UPSTREAM_FAILURE]: (e) =>
          Effect.gen(function* () {
            const tokensUsed = yield* Ref.get(tokensUsedRef);
            return yield* finalAbort(
              ABORT.UPSTREAM_FAILURE,
              { cause: publicRuntimeCauseReason(e.cause) },
              identity,
              started.id,
              tokensUsed,
              traceContext,
            );
          }),
        [ABORT.TOOL_ERROR]: (e) =>
          Effect.gen(function* () {
            const tokensUsed = yield* Ref.get(tokensUsedRef);
            if (isToolBudgetTimeError(e)) {
              return yield* finalAbort(
                ABORT.BUDGET_TIME,
                toolBudgetTimePayload(e),
                identity,
                started.id,
                tokensUsed,
                traceContext,
              );
            }
            return yield* finalAbort(
              ABORT.TOOL_ERROR,
              { toolName: e.toolName, cause: publicRuntimeCauseReason(e.cause) },
              identity,
              started.id,
              tokensUsed,
              traceContext,
            );
          }),
      }),
    );
  });
