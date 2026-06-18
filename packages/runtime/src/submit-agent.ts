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
  type LlmToolChoice,
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
  continuationRefFromInterruptedEvent,
  decodeRuntimeLedgerEvent,
  EXTERNAL_TOOL_EXECUTION_REQUIRES_RECEIPT_REASON,
  inputRequestRefFromInterruptedEvent,
  llmRequestedEvent,
  llmResponseEvent,
  RUNTIME_FACT_OWNER,
  RUNTIME_EVENT_KIND,
  receiptBackedToolResultFromUnknown,
  runtimeCompletedAfterToolsEvent,
  runtimeHistoryCompactedEvent,
  toolExecutedEvent,
  toolReplayArtifactFromExecutedPayload,
  toolRejectedEvent,
  replayToolFromArtifact,
  type SubmitDecisionInterrupt,
  type SubmitResult,
  type ToolArgumentSummary,
  type ToolRejectedDiagnostics,
  type TurnRef,
} from "@agent-os/runtime-protocol";
import type { LedgerTruthIdentity } from "@agent-os/runtime-protocol";
import type { InternalSubmitSpec } from "./internal-submit";
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
  settleToolPolicyRejected,
  settleToolValidationRejected,
  toolAdmissionFailureCause,
  toolErrorReason,
  publicRuntimeCauseReason,
} from "./tool-settlement";
import { BoundaryEvents } from "./boundary-events";
import type { BoundaryCommitRejected } from "./boundary-commit";
import { appendNextDriverAction, appendRuntimeDriverAction } from "./driver";
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

const toolDefinitionsForRuntimePolicy = (
  tools: Record<string, Tool>,
  requiredToolNames: ReadonlyArray<string>,
  executedToolNames: ReadonlySet<string>,
): ReadonlyArray<ToolDefinition> => {
  if (requiredToolNames.length === 0) return toolDefinitionsOf(tools);
  const policyTools = new Set(requiredToolNames);
  return Object.entries(tools)
    .filter(([toolName]) => !policyTools.has(toolName) || !executedToolNames.has(toolName))
    .map(([, tool]) => tool.definition);
};

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
): {
  readonly reason: "budget_time";
  readonly elapsedMs: number;
  readonly maxMs: number;
} => ({
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
  const cause = error.cause as {
    readonly elapsedMs?: unknown;
    readonly maxMs?: unknown;
  };
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
): SubmitResult => {
  const interruption = matchingInterruptionEvent(events, {
    runId,
    turn: spec.turn,
    interruptId: spec.interruptId,
    gateRef: spec.gateRef,
    decisionRef: "",
    resume: undefined,
  });
  if (interruption === undefined) {
    throw new TypeError("interrupted SubmitResult requires a matching interruption ledger fact");
  }
  const decoded = decodeRuntimeLedgerEvent(interruption);
  if (
    decoded._tag !== "runtime" ||
    decoded.event.kind !== RUNTIME_EVENT_KIND.AGENT_RUN_INTERRUPTED
  ) {
    throw new TypeError("interrupted SubmitResult matched a non-interruption ledger fact");
  }
  const continuation = continuationRefFromInterruptedEvent(decoded.event);
  if (!continuation.ok) {
    throw new TypeError("interrupted SubmitResult requires a decision-bound interruption fact");
  }
  const inputRequest = inputRequestRefFromInterruptedEvent(decoded.event);
  return {
    ok: false,
    status: "interrupted",
    runId,
    reason: "interrupted",
    eventCount: events.length,
    tokensUsed: spec.tokensUsed,
    interruptId: spec.interruptId,
    turn: spec.turn,
    gateRef: spec.gateRef,
    continuation: continuation.ref,
    ...(inputRequest.ok ? { inputRequest: inputRequest.descriptor } : {}),
  };
};

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

const MAX_PROVIDER_HISTORY_STRING_BYTES = 512;

const compactProviderHistoryValue = (value: unknown): unknown => {
  if (typeof value === "string") {
    const bytes = toolArgumentSummaryEncoder.encode(value).byteLength;
    if (bytes <= MAX_PROVIDER_HISTORY_STRING_BYTES) return value;
    return `[agentOS redacted provider history string: ${bytes} bytes]`;
  }
  if (Array.isArray(value)) {
    return value.map(compactProviderHistoryValue);
  }
  if (Predicate.isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, compactProviderHistoryValue(entry)]),
    );
  }
  return value;
};

const providerHistoryArgumentsJson = (
  tool: Tool,
  toolName: string,
  args: unknown,
  originalArguments: string,
): Effect.Effect<string, JsonStringifyError> =>
  Effect.gen(function* () {
    const compacted = compactProviderHistoryValue(args);
    const decoded = yield* Effect.either(decodeToolArgs(tool, compacted, toolName));
    if (decoded._tag === "Left") return originalArguments;
    return yield* safeStringify(compacted);
  });

type ProviderHistoryCompaction = {
  readonly originalBytes: number;
  readonly compactedBytes: number;
};

const compactProviderHistoryToolCall = (
  messages: LlmMessage[],
  toolCallId: string,
  argumentsJson: string,
): ProviderHistoryCompaction | null => {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== "assistant" || message.tool_calls === undefined) continue;
    if (!message.tool_calls.some((call) => call.id === toolCallId)) continue;
    const existingCall = message.tool_calls.find((call) => call.id === toolCallId);
    const originalArguments = existingCall?.function.arguments;
    if (originalArguments === undefined || originalArguments === argumentsJson) {
      return null;
    }
    const originalBytes = toolArgumentSummaryEncoder.encode(originalArguments).byteLength;
    const compactedBytes = toolArgumentSummaryEncoder.encode(argumentsJson).byteLength;
    if (compactedBytes >= originalBytes) return null;
    messages[index] = {
      ...message,
      tool_calls: message.tool_calls.map((call) =>
        call.id === toolCallId
          ? {
              ...call,
              function: {
                ...call.function,
                arguments: argumentsJson,
              },
            }
          : call,
      ),
    };
    return { originalBytes, compactedBytes };
  }
  return null;
};

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
    readonly sourceEventId: number;
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
          return { messages, call, sourceEventId: llmEvent.id };
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
          compactProviderHistoryToolCall(messages, call.id, call.function.arguments);
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
    yield* appendRuntimeDriverAction(ledger, {
      kind: "abort",
      event: agentRunAbortedEvent({
        ...identity,
        kind,
        runId,
        tokensUsed,
        payload,
        traceContext,
      }),
    });
    const events = yield* ledger.events(identity);
    return yield* submitResultFromEvents(events, runId);
  });

const llmTimeoutFor = (
  startTime: number,
  now: number,
  budgetTimeMs: number,
  llmCallTimeoutMs: number,
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
    if (remaining <= llmCallTimeoutMs) {
      return { ok: true, mode: "budget", timeoutMs: remaining };
    }
  }
  return { ok: true, mode: "provider", timeoutMs: llmCallTimeoutMs };
};

const llmCallTimeoutBudgetMs = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : DEFAULT_LLM_CALL_TIMEOUT_MS;

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

const singleRequiredToolPolicyName = (spec: InternalSubmitSpec): string | null => {
  const toolName = spec.toolPolicy?.requiredUntilToolExecuted?.toolName;
  return typeof toolName === "string" && toolName.length > 0 ? toolName : null;
};

const completeAfterToolPolicyNames = (spec: InternalSubmitSpec): ReadonlyArray<string> => {
  const toolNames = spec.toolPolicy?.completeAfterToolsExecuted?.toolNames ?? [];
  return [...new Set(toolNames.filter((toolName) => toolName.length > 0))];
};

const routeModelId = (route: LlmRoute): string | undefined =>
  typeof route.modelId === "string" && route.modelId.length > 0 ? route.modelId : undefined;

const requiredToolPolicyNames = (spec: InternalSubmitSpec): ReadonlyArray<string> => [
  ...new Set(
    [singleRequiredToolPolicyName(spec), ...completeAfterToolPolicyNames(spec)].filter(
      (toolName): toolName is string => toolName !== null,
    ),
  ),
];

const hasExecutedTool = (
  events: ReadonlyArray<LedgerEvent>,
  runId: number,
  toolName: string,
): boolean =>
  events.some((event) => {
    const decoded = decodeRuntimeLedgerEvent(event);
    return (
      decoded._tag === "runtime" &&
      decoded.event.kind === RUNTIME_EVENT_KIND.TOOL_EXECUTED &&
      decoded.event.payload.runId === runId &&
      decoded.event.payload.name === toolName
    );
  });

const safeToolChoiceSummary = (toolChoice: LlmToolChoice | undefined): string | undefined => {
  if (toolChoice === undefined) return undefined;
  if (typeof toolChoice === "string") return toolChoice;
  const functionName = toolChoice.function.name;
  return functionName.length > 0 ? `function:${functionName}` : "function";
};

const toolChoiceForRuntimePolicy = (input: {
  readonly requiredToolNames: ReadonlyArray<string>;
  readonly executedToolNames: ReadonlySet<string>;
  readonly ordered: boolean;
}): LlmToolChoice | undefined => {
  const missing = input.requiredToolNames.filter(
    (toolName) => !input.executedToolNames.has(toolName),
  );
  if (missing.length === 0) return undefined;
  const hasExecutedPolicyTool = input.requiredToolNames.some((toolName) =>
    input.executedToolNames.has(toolName),
  );
  if (!hasExecutedPolicyTool) return "required";
  if (input.ordered || missing.length === 1) {
    return { type: "function", function: { name: missing[0] as string } };
  }
  return "required";
};

const remainingRequiredToolNames = (
  requiredToolNames: ReadonlyArray<string>,
  executedToolNames: ReadonlySet<string>,
): ReadonlyArray<string> =>
  requiredToolNames.filter((toolName) => !executedToolNames.has(toolName));

const allPolicyToolsExecuted = (
  toolNames: ReadonlyArray<string>,
  executedToolNames: ReadonlySet<string>,
): boolean =>
  toolNames.length > 0 && toolNames.every((toolName) => executedToolNames.has(toolName));

const policyToolViolationReason = (input: {
  readonly toolName: string;
  readonly requiredToolNames: ReadonlyArray<string>;
  readonly executedToolNames: ReadonlySet<string>;
  readonly ordered: boolean;
}): "policy_tool_already_executed" | "policy_tool_out_of_order" | null => {
  if (!input.requiredToolNames.includes(input.toolName)) return null;
  if (input.executedToolNames.has(input.toolName)) return "policy_tool_already_executed";
  if (!input.ordered) return null;
  const expectedToolName = remainingRequiredToolNames(
    input.requiredToolNames,
    input.executedToolNames,
  )[0];
  return expectedToolName !== undefined && input.toolName !== expectedToolName
    ? "policy_tool_out_of_order"
    : null;
};

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
    const llmCallTimeoutMs = llmCallTimeoutBudgetMs(spec.budget?.llmCallTimeoutMs);
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
    let toolValidationFailures = 0;
    const started =
      spec.resume === undefined
        ? (yield* appendRuntimeDriverAction(ledger, {
            kind: "start",
            event: agentRunStartedEvent({
              ...identity,
              intent: spec.intent,
              traceContext,
            }),
          })).event
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
      yield* appendRuntimeDriverAction(ledger, {
        kind: "ingest_chat",
        event: chatIngestedEvent({
          ...identity,
          runId: started.id,
          intent: spec.intent,
          context: spec.context,
          traceContext,
        }),
      });
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
      const timeout = llmTimeoutFor(startTime, beforeCall, budgetTimeMs, llmCallTimeoutMs);
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
        yield* appendRuntimeDriverAction(ledger, {
          kind: "complete",
          event: agentRunCompletedEvent({
            ...identity,
            runId: started.id,
            final: finalStr,
            output: result.decoded,
            outputKind: "json",
            tokensUsed: tokens,
            traceContext,
          }),
        });
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
    const requiredToolNames = requiredToolPolicyNames(spec);
    const completeAfterToolNames = completeAfterToolPolicyNames(spec);
    const orderedCompleteAfterTools = spec.toolPolicy?.completeAfterToolsExecuted?.ordered === true;
    const unknownPolicyToolName = requiredToolNames.find(
      (toolName) => spec.tools[toolName] === undefined,
    );
    if (unknownPolicyToolName !== undefined) {
      return yield* finalAbort(
        ABORT.TOOL_ERROR,
        {
          reason: "invalid_tool_policy_unknown_tool",
          toolName: unknownPolicyToolName,
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
      const quotaService = yield* Quota;
      const llm = yield* LlmTransport;
      const boundaryEvents = yield* BoundaryEvents;
      const projections = yield* MaterializedProjections;
      const refs = yield* RefResolverService;
      const recordProviderHistoryCompaction = (input: {
        readonly turn: TurnRef;
        readonly sourceEventId: number | undefined;
        readonly toolCallId: string;
        readonly toolName: string;
        readonly argumentsJson: string;
      }): Effect.Effect<void, SqlError | JsonStringifyError> =>
        Effect.gen(function* () {
          const compaction = compactProviderHistoryToolCall(
            messages,
            input.toolCallId,
            input.argumentsJson,
          );
          if (compaction === null) return;
          if (input.sourceEventId === undefined) {
            return yield* Effect.fail(
              new SqlError({
                cause: {
                  reason: "provider_history_compaction_missing_source_event",
                  runId: started.id,
                  turn: input.turn,
                  toolCallId: input.toolCallId,
                  toolName: input.toolName,
                },
              }),
            );
          }
          yield* appendRuntimeDriverAction(ledger, {
            kind: "compact_history",
            event: runtimeHistoryCompactedEvent({
              ...identity,
              runId: started.id,
              turn: input.turn,
              sourceEventId: input.sourceEventId,
              toolCallId: input.toolCallId,
              toolName: input.toolName,
              originalBytes: compaction.originalBytes,
              compactedBytes: compaction.compactedBytes,
              traceContext,
            }),
          });
        });
      let firstTurn = 0;
      let resumedToolCall: LlmToolCall | undefined;
      let resumedToolCallSourceEventId: number | undefined;
      let toolPolicyFailures = 0;
      const executedToolNames = new Set(
        requiredToolNames.filter((toolName) => hasExecutedTool(priorEvents, started.id, toolName)),
      );

      if (spec.resume !== undefined) {
        const resume = spec.resume;
        const interruption = matchingInterruptionEvent(priorEvents, resume);
        if (interruption === undefined) {
          return yield* finalAbort(
            ABORT.TOOL_ERROR,
            {
              reason: "resume_missing_matching_interruption",
              interruptId: resume.interruptId,
              gateRef: resume.gateRef,
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
              interruptId: resume.interruptId,
            },
            identity,
            started.id,
            0,
            traceContext,
          );
        }

        const projection = projectDecisionGate(priorEvents, resume.gateRef);
        if (
          projection.status !== "approved" ||
          projection.decision?.decisionRef !== resume.decisionRef ||
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
              gateRef: resume.gateRef,
              decisionRef: resume.decisionRef,
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
          resume.gateRef,
          resume.decisionRef,
        );
        if (decisionEvent === undefined) {
          return yield* finalAbort(
            ABORT.TOOL_ERROR,
            {
              reason: "decision_gate_approved_without_decision_event",
              gateRef: resume.gateRef,
              decisionRef: resume.decisionRef,
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
          resume,
          decision.toolCallId,
          spec.executionDomains ?? [],
        );
        messages = replayed.messages;
        resumedToolCall = replayed.call;
        resumedToolCallSourceEventId = replayed.sourceEventId;
        firstTurn = resume.turn.index;
        const priorTokens = priorEvents.reduce((sum, event) => {
          const decoded = decodeRuntimeLedgerEvent(event);
          return decoded._tag === "runtime" &&
            decoded.event.kind === RUNTIME_EVENT_KIND.LLM_RESPONSE &&
            decoded.event.payload.turn.id === resume.runId
            ? sum + decoded.event.payload.usage.totalTokens
            : sum;
        }, 0);
        yield* Ref.set(tokensUsedRef, priorTokens);

        yield* appendNextDriverAction(
          { ledger, boundaryEvents },
          {
            kind: "resume",
            consumed: {
              gateRef: resume.gateRef,
              decisionRef: resume.decisionRef,
              consumedBy: `agent.run:${resume.runId}`,
              claim: settleDecisionGateConsumed(projection.request.claim, {
                gateRef: resume.gateRef,
                eventId: decisionEvent.id,
              }),
            },
            resumed: (resumedAtEventId) =>
              agentRunResumedEvent({
                ...identity,
                runId: resume.runId,
                turn: resume.turn,
                interruptId: resume.interruptId,
                resume: resume.resume,
                resumedAtEventId,
                traceContext,
              }),
          },
        );
      }

      for (let turn = firstTurn; turn < maxTurns; turn++) {
        const now = yield* Clock.currentTimeMillis;
        const tokensBeforeCall = yield* Ref.get(tokensUsedRef);

        const resumedThisTurn = resumedToolCall;
        const resumedSourceEventIdThisTurn = resumedToolCallSourceEventId;
        resumedToolCall = undefined;
        resumedToolCallSourceEventId = undefined;
        const resumedToolCallIdThisTurn = resumedThisTurn?.id;
        const responseToolCalls: LlmToolCall[] =
          resumedThisTurn === undefined ? [] : [resumedThisTurn];
        const responseToolCallSourceEventIds = new Map<string, number>();
        if (resumedThisTurn !== undefined && resumedSourceEventIdThisTurn !== undefined) {
          responseToolCallSourceEventIds.set(resumedThisTurn.id, resumedSourceEventIdThisTurn);
        }
        let newTokens = tokensBeforeCall;

        if (resumedThisTurn === undefined) {
          const timeout = llmTimeoutFor(startTime, now, budgetTimeMs, llmCallTimeoutMs);
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
          const toolDefs = toolDefinitionsForRuntimePolicy(
            spec.tools,
            requiredToolNames,
            executedToolNames,
          );
          const toolChoice = toolChoiceForRuntimePolicy({
            requiredToolNames,
            executedToolNames,
            ordered: orderedCompleteAfterTools,
          });
          const modelId = routeModelId(spec.route);
          const toolChoiceSummary = safeToolChoiceSummary(toolChoice);
          yield* appendRuntimeDriverAction(ledger, {
            kind: "request_llm",
            event: llmRequestedEvent({
              ...identity,
              runId: started.id,
              turn: turnRefOf(started.id, turn),
              ...(modelId === undefined ? {} : { modelId }),
              toolNames: toolDefs.map((tool) => tool.function.name),
              ...(toolChoiceSummary === undefined ? {} : { toolChoice: toolChoiceSummary }),
              traceContext,
            }),
          });
          const timedResp = yield* Effect.either(
            llm
              .call(
                {
                  route: spec.route,
                  messages,
                  tools: toolDefs.length > 0 ? toolDefs : undefined,
                  tool_choice: toolChoice,
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

          const recordedLlmResponse = yield* appendRuntimeDriverAction(ledger, {
            kind: "record_llm_response",
            event: llmResponseEvent({
              ...identity,
              turn: turnRefOf(started.id, turn),
              items: resp.items,
              usage: resp.usage,
              traceContext,
            }),
          });
          for (const call of nextResponseToolCalls) {
            responseToolCallSourceEventIds.set(call.id, recordedLlmResponse.event.id);
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

          messages.push({
            role: "assistant",
            content: nextResponseText,
            tool_calls: nextResponseToolCalls.length > 0 ? nextResponseToolCalls : undefined,
          });

          if (nextResponseToolCalls.length === 0) {
            const remainingPolicyToolNames = remainingRequiredToolNames(
              requiredToolNames,
              executedToolNames,
            );
            if (remainingPolicyToolNames.length > 0) {
              if (toolPolicyFailures >= toolRetries) {
                return yield* new ToolError({
                  toolName: remainingPolicyToolNames[0] as string,
                  cause: {
                    reason: "policy_required_tool_missing",
                    remainingRequiredToolNames: remainingPolicyToolNames,
                  },
                });
              }
              toolPolicyFailures++;
              messages.push({
                role: "user",
                content: yield* safeStringify({
                  ok: false,
                  error: "tool_policy_required_tool_missing",
                  phase: "policy",
                  remainingRequiredToolNames: remainingPolicyToolNames,
                  expectedToolName: orderedCompleteAfterTools
                    ? remainingPolicyToolNames[0]
                    : undefined,
                  message:
                    "A required runtime policy tool has not executed. Continue by calling one of the remaining required tool names; prose-only completion is not accepted.",
                }),
              });
              continue;
            }
            yield* appendRuntimeDriverAction(ledger, {
              kind: "complete",
              event: agentRunCompletedEvent({
                ...identity,
                runId: started.id,
                final: nextResponseText,
                output: nextResponseText,
                outputKind: "text",
                tokensUsed: newTokens,
                turn: turnRefOf(started.id, turn),
                traceContext,
              }),
            });
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
          const policyViolationReason = policyToolViolationReason({
            toolName: call.function.name,
            requiredToolNames,
            executedToolNames,
            ordered: orderedCompleteAfterTools,
          });
          if (policyViolationReason !== null) {
            yield* appendRuntimeDriverAction(ledger, {
              kind: "reject_tool",
              event: toolRejectedEvent({
                ...identity,
                runId: started.id,
                toolCallId: call.id,
                name: call.function.name,
                args: summarizeToolArguments(call.function.arguments),
                execution: tool.execution,
                claim: settleToolPolicyRejected(claim, policyViolationReason),
                diagnostics: {
                  phase: "policy",
                  reason: policyViolationReason,
                  argumentSummary: summarizeToolArguments(call.function.arguments),
                },
                traceContext,
              }),
            });
            if (toolPolicyFailures >= toolRetries) {
              return yield* new ToolError({
                toolName: call.function.name,
                cause: {
                  reason: policyViolationReason,
                  remainingRequiredToolNames: remainingRequiredToolNames(
                    requiredToolNames,
                    executedToolNames,
                  ),
                },
              });
            }
            toolPolicyFailures++;
            yield* recordProviderHistoryCompaction({
              turn: turnRefOf(started.id, turn),
              sourceEventId: responseToolCallSourceEventIds.get(call.id),
              toolCallId: call.id,
              toolName: call.function.name,
              argumentsJson: call.function.arguments,
            });
            const feedback = yield* safeStringify({
              ok: false,
              error: "tool_policy_rejected",
              phase: "policy",
              reason: policyViolationReason,
              toolName: call.function.name,
              remainingRequiredToolNames: remainingRequiredToolNames(
                requiredToolNames,
                executedToolNames,
              ),
              expectedToolName: orderedCompleteAfterTools
                ? remainingRequiredToolNames(requiredToolNames, executedToolNames)[0]
                : undefined,
              message:
                "This declared terminal tool call violates runtime policy. Continue with the remaining required tool names.",
            });
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              name: call.function.name,
              content: feedback,
            });
            continue;
          }
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
            yield* appendRuntimeDriverAction(ledger, {
              kind: "reject_tool",
              event: toolRejectedEvent({
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
            });
            if (toolValidationFailures >= toolRetries) {
              return yield* parsed.left;
            }
            toolValidationFailures++;
            yield* recordProviderHistoryCompaction({
              turn: turnRefOf(started.id, turn),
              sourceEventId: responseToolCallSourceEventIds.get(call.id),
              toolCallId: call.id,
              toolName: call.function.name,
              argumentsJson: call.function.arguments,
            });
            const feedback = yield* safeStringify({
              ok: false,
              error: "invalid_tool_arguments",
              phase: "parse",
              reason: "invalid_args",
              toolName: call.function.name,
              message:
                "Tool arguments were not valid JSON. Retry the same tool with valid JSON arguments.",
            });
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              name: call.function.name,
              content: feedback,
            });
            continue;
          }
          const decoded = yield* Effect.either(
            decodeToolArgs(tool, parsed.right, call.function.name),
          );
          if (decoded._tag === "Left") {
            const schemaIssues = schemaIssuesFromToolError(decoded.left);
            yield* appendRuntimeDriverAction(ledger, {
              kind: "reject_tool",
              event: toolRejectedEvent({
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
            });
            if (toolValidationFailures >= toolRetries) {
              return yield* decoded.left;
            }
            toolValidationFailures++;
            yield* recordProviderHistoryCompaction({
              turn: turnRefOf(started.id, turn),
              sourceEventId: responseToolCallSourceEventIds.get(call.id),
              toolCallId: call.id,
              toolName: call.function.name,
              argumentsJson: call.function.arguments,
            });
            const feedback = yield* safeStringify({
              ok: false,
              error: "invalid_tool_arguments",
              phase: "decode",
              reason: "invalid_args",
              toolName: call.function.name,
              message:
                "Tool arguments did not match the tool schema. Retry the same tool with corrected JSON arguments.",
              ...(schemaIssues === undefined ? {} : { schemaIssues }),
            });
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              name: call.function.name,
              content: feedback,
            });
            continue;
          }
          const args = decoded.right;

          const interrupt = decisionInterruptFor(spec, call.function.name);
          if (interrupt !== undefined && call.id !== resumedToolCallIdThisTurn) {
            const gateRef = decisionGateRefFor(interrupt, claim.operationRef);
            const interruptId = decisionInterruptIdFor(interrupt, claim.operationRef);
            const subjectRef = decisionSubjectRefFor(claim);
            yield* appendNextDriverAction(
              { ledger, boundaryEvents },
              {
                kind: "park",
                request: {
                  gateRef,
                  subjectRef,
                  ...(interrupt.policyRef === undefined ? {} : { policyRef: interrupt.policyRef }),
                  ...(interrupt.summary === undefined ? {} : { summary: interrupt.summary }),
                  claim,
                },
                interruption: agentRunInterruptedEvent({
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
              },
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
            yield* appendRuntimeDriverAction(ledger, {
              kind: "reject_tool",
              event: toolRejectedEvent({
                ...identity,
                runId: started.id,
                toolCallId: call.id,
                name: call.function.name,
                args: call.function.arguments,
                execution: tool.execution,
                claim: settleToolAdmissionRejected(claim, resolvedMaterials.rejectionRef),
                traceContext,
              }),
            });
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
            yield* appendRuntimeDriverAction(ledger, {
              kind: "reject_tool",
              event: toolRejectedEvent({
                ...identity,
                runId: started.id,
                toolCallId: call.id,
                name: call.function.name,
                args: call.function.arguments,
                execution: tool.execution,
                claim: settleToolAdmissionRejected(claim, rejectedAdmission),
                traceContext,
              }),
            });
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
            yield* appendRuntimeDriverAction(ledger, {
              kind: "reject_tool",
              event: toolRejectedEvent({
                ...identity,
                runId: started.id,
                toolCallId: call.id,
                name: call.function.name,
                args: call.function.arguments,
                execution: tool.execution,
                claim: settleToolExecutionRejected(claim, receiptBindingReason),
                traceContext,
              }),
            });
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
                      cause: {
                        reason: "invalid_quota_window",
                        windowMs: q.windowMs,
                      },
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
                  yield* appendRuntimeDriverAction(ledger, {
                    kind: "reject_tool",
                    event: toolRejectedEvent({
                      ...identity,
                      runId: started.id,
                      toolCallId: call.id,
                      name: call.function.name,
                      args: call.function.arguments,
                      execution: tool.execution,
                      claim: settleToolExecutionRejected(claim, reason),
                      traceContext,
                    }),
                  });
                  return yield* error;
                }),
            }),
          );

          const terminal =
            resolvedExecution.resolved.witness === "receipt"
              ? receiptBackedToolResultFromUnknown(result)
              : null;
          if (resolvedExecution.resolved.witness === "receipt" && terminal === null) {
            yield* appendRuntimeDriverAction(ledger, {
              kind: "reject_tool",
              event: toolRejectedEvent({
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
            });
            return yield* new ToolError({
              toolName: call.function.name,
              cause: {
                reason: EXTERNAL_TOOL_EXECUTION_REQUIRES_RECEIPT_REASON,
              },
            });
          }
          if (
            terminal !== null &&
            (!claimMatchesPreClaim(terminal.claim, claim) ||
              terminal.receipt.anchorKind !== "external_receipt")
          ) {
            yield* appendRuntimeDriverAction(ledger, {
              kind: "reject_tool",
              event: toolRejectedEvent({
                ...identity,
                runId: started.id,
                toolCallId: call.id,
                name: call.function.name,
                args: call.function.arguments,
                execution: tool.execution,
                claim: settleToolExecutionRejected(claim, "receipt_backed_tool_claim_mismatch"),
                traceContext,
              }),
            });
            return yield* new ToolError({
              toolName: call.function.name,
              cause: { reason: "receipt_backed_tool_claim_mismatch" },
            });
          }

          const toolResult = terminal?.result ?? result;
          const toolClaim = terminal?.claim ?? settleToolExecuted(claim, contract);
          const resultStr = yield* safeStringify(toolResult);
          yield* appendRuntimeDriverAction(ledger, {
            kind: "record_tool_result",
            event: toolExecutedEvent({
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
          });
          if (requiredToolNames.includes(call.function.name)) {
            executedToolNames.add(call.function.name);
          }
          const historyArguments = yield* providerHistoryArgumentsJson(
            tool,
            call.function.name,
            args,
            call.function.arguments,
          );
          yield* recordProviderHistoryCompaction({
            turn: turnRefOf(started.id, turn),
            sourceEventId: responseToolCallSourceEventIds.get(call.id),
            toolCallId: call.id,
            toolName: call.function.name,
            argumentsJson: historyArguments,
          });
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            name: call.function.name,
            content: resultStr,
          });
          if (
            completeAfterToolNames.length > 0 &&
            allPolicyToolsExecuted(requiredToolNames, executedToolNames)
          ) {
            const final =
              spec.toolPolicy?.completeAfterToolsExecuted?.finalMessage ??
              "completed after declared tools executed";
            yield* appendRuntimeDriverAction(ledger, {
              kind: "complete_after_tools",
              events: [
                runtimeCompletedAfterToolsEvent({
                  ...identity,
                  runId: started.id,
                  turn: turnRefOf(started.id, turn),
                  toolNames: completeAfterToolNames,
                  tokensUsed: newTokens,
                  traceContext,
                }),
                agentRunCompletedEvent({
                  ...identity,
                  runId: started.id,
                  final,
                  output: final,
                  outputKind: "text",
                  tokensUsed: newTokens,
                  turn: turnRefOf(started.id, turn),
                  traceContext,
                }),
              ],
            });
            const events = yield* ledger.events(identity);
            return yield* submitResultFromEvents(events, started.id);
          }
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
              {
                toolName: e.toolName,
                cause: publicRuntimeCauseReason(e.cause),
              },
              identity,
              started.id,
              tokensUsed,
              traceContext,
            );
          }),
      }),
    );
  });
