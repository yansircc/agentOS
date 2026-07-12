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
 * before returning SubmitResult{ok:false}. Only RuntimeStorageError |
 * JsonStringifyError escape (irrecoverable infra failures).
 *
 * submitAgentEffect is module-private. Apps call Cloudflare backend.submit(spec)
 * which injects scope from ctx.id.name (SSoT) and runs this effect.
 */

import { Clock, Duration, Effect, Ref } from "effect";
import { projectDecisionGate, settleDecisionGateConsumed } from "./decision-gate";
import {
  JsonStringifyError,
  safeStringify,
  safeStringifyPretty,
  ToolError,
  UpstreamFailure,
} from "@agent-os/core/errors";
import { ABORT } from "@agent-os/core/abort";
import { backendProtocolTruthIdentityKey } from "@agent-os/core/backend-protocol";
import {
  markerFromProviderContinuation,
  textFromLlmOutputItems,
  toolCallsFromLlmOutputItems,
  type LlmToolCall,
  type LlmMessage,
  type LlmRoute,
} from "@agent-os/core/llm-protocol";
import { LlmTransport } from "@agent-os/core/llm-protocol";
import {
  InvalidTraceContext,
  copyTraceContext,
  validateOptionalTraceContext,
} from "@agent-os/core/telemetry-protocol";
import {
  agentMaterialResolvedEvent,
  agentRunCompletedEvent,
  agentRunInterruptedEvent,
  agentRunResumedEvent,
  agentRunStartedEvent,
  agentSessionTurnSubmittedEvent,
  chatIngestedEvent,
  decodeRuntimeLedgerEvent,
  EXTERNAL_TOOL_EXECUTION_REQUIRES_RECEIPT_REASON,
  inputRequestRefFromInterruptedEvent,
  llmRequestedEvent,
  llmResponseEvent,
  parseInputRequestResumePayload,
  productRunLinkedEvent,
  RUNTIME_EVENT_KIND,
  receiptBackedToolResultFromUnknown,
  runtimeCompletedAfterToolsEvent,
  runtimeHistoryCompactedEvent,
  toolExecutedEvent,
  toolRejectedEvent,
  workflowRunSubmittedEvent,
  type InputRequestResumePayload,
  type SubmitResult,
  type TurnRef,
} from "@agent-os/core/runtime-protocol";
import type { LedgerTruthIdentity } from "@agent-os/core/runtime-protocol";
import type { InternalSubmitSpec } from "./internal-submit";
import { Ledger, runtimeStorageError, type RuntimeStorageError } from "./ledger";
import { RefResolutionFailed, RefResolverService } from "@agent-os/core/ref-resolver";
import type { MaterialResolutionReceipt } from "@agent-os/core/ref-resolver";
import { materialRefKey } from "@agent-os/core/material-ref";
import { Quota } from "./quota-service";
import {
  decodeToolArgs,
  executeTool,
  resolveToolExecution,
  validateExecutionDomainRegistry,
  validateToolRegistry,
} from "@agent-os/core/tools";
import { makeAdmissionSchemaSpec } from "@agent-os/core/runtime-protocol";
import { Admission } from "./admission";
import { projectSubmitResult } from "./run-projector";
import {
  admitterErrorRejectionRef,
  makeOperationRef,
  makePreClaim,
  normalizeAdmitVerdict,
  type RejectionRef,
} from "@agent-os/core/effect-claim";
import {
  settleToolAdmissionRejected,
  settleToolExecuted,
  settleToolExecutionRejected,
  settleToolPolicyRejected,
  settleToolValidationRejected,
  toolAdmissionFailureCause,
  toolErrorReason,
} from "./tool-settlement";
import { publicRuntimeCauseReason } from "./failure-classification";
import { BoundaryEvents } from "./boundary-events";
import type { BoundaryCommitRejected } from "./boundary-commit";
import { appendNextDriverAction, appendRuntimeDriverAction } from "./driver";
import { MaterializedProjections } from "./projection";
import { normalizeSubmitToolRetryPolicy } from "./submit-retry-policy";
import {
  decisionGateClaimFor,
  decisionGateRefFor,
  decisionInterruptFor,
  decisionInterruptIdFor,
  decisionSubjectRefFor,
  matchingDecisionEvent,
  matchingInterruptionEvent,
} from "./submit-agent/decision-interrupts";
import {
  isLlmCallTimedOut,
  llmCallTimeoutBudgetMs,
  llmTimeoutFor,
  runTimedLlmAttempt,
  timeoutAbortResult,
  turnRefOf,
} from "./submit-agent/llm-timeout";
export { DEFAULT_LLM_CALL_TIMEOUT_MS, turnRefOf } from "./submit-agent/llm-timeout";
import {
  planToolMaterials,
  withLocalResolvedToolMaterials,
} from "./submit-agent/material-planning";
import {
  compactProviderHistoryToolCall,
  providerHistoryArgumentsJson,
  replayMessagesToInterruptedTool,
} from "./submit-agent/provider-history";
import { finalAbort, submitResultFromEvents } from "./submit-agent/result";
import {
  allPolicyToolsExecuted,
  completeAfterToolPolicyNames,
  completeAfterToolsRequireInvocation,
  hasExecutedTool,
  policyToolViolationReason,
  remainingRequiredToolNames,
  requiredToolPolicyNames,
  routeModelId,
  safeToolChoiceSummary,
  toolChoiceForRuntimePolicy,
  toolDefinitionsForRuntimePolicy,
} from "./submit-agent/tool-policy";
import {
  claimMatchesPreClaim,
  isToolBudgetTimeError,
  receiptBackedToolBindingReason,
  runtimeToolContext,
  schemaIssuesFromToolError,
  summarizeToolArguments,
  toolBudgetTimeCause,
  toolBudgetTimePayload,
} from "./submit-agent/tool-runtime";
import {
  DYNAMIC_TOOL_VISIBILITY_DENIED_REASON,
  dynamicCapabilityPhasePolicyDeniedDiagnostic,
  dynamicCapabilityToolVisibilityDenied,
  instructionFragmentsForDynamicCapabilityProjection,
  systemWithDynamicInstructionFragments,
  toolsForDynamicCapabilityProjection,
} from "./submit-agent/dynamic-capability";

export const buildInitialMessages = (
  spec: Pick<InternalSubmitSpec, "system" | "intent" | "context">,
): Effect.Effect<ReadonlyArray<LlmMessage>, JsonStringifyError> =>
  Effect.withSpan("agentos.runtime.submit_agent.build_initial_messages")(
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
    }),
  );

export type SubmitAgentProductLink =
  | {
      readonly kind: "session_turn";
      readonly sessionRef: string;
      readonly turnRef: string;
      readonly idempotencyKey?: string;
    }
  | {
      readonly kind: "workflow_run";
      readonly workflowId: string;
      readonly workflowRunId: string;
      readonly idempotencyKey?: string;
      readonly inputDigest?: string;
    }
  | {
      readonly kind: "opaque";
      readonly productRef: string;
      readonly idempotencyKey?: string;
      readonly inputDigest?: string;
    };

export interface SubmitAgentOptions {
  readonly productLink?: SubmitAgentProductLink;
}

const productLinkEventFor = (
  productLink: SubmitAgentProductLink,
  identity: LedgerTruthIdentity,
  runtimeRunId: number,
  traceContext: InternalSubmitSpec["traceContext"],
) => {
  switch (productLink.kind) {
    case "session_turn":
      return agentSessionTurnSubmittedEvent({
        ...identity,
        sessionRef: productLink.sessionRef,
        turnRef: productLink.turnRef,
        runtimeRunId,
        idempotencyKey: productLink.idempotencyKey,
        traceContext,
      });
    case "workflow_run":
      return workflowRunSubmittedEvent({
        ...identity,
        workflowId: productLink.workflowId,
        workflowRunId: productLink.workflowRunId,
        runtimeRunId,
        idempotencyKey: productLink.idempotencyKey,
        inputDigest: productLink.inputDigest,
        traceContext,
      });
    case "opaque":
      return productRunLinkedEvent({
        ...identity,
        productRef: productLink.productRef,
        runtimeRunId,
        idempotencyKey: productLink.idempotencyKey,
        inputDigest: productLink.inputDigest,
        traceContext,
      });
  }
};

export const submitAgentEffect = (
  spec: InternalSubmitSpec,
  options: SubmitAgentOptions = {},
): Effect.Effect<
  SubmitResult,
  | RuntimeStorageError
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
  Effect.withSpan("agentos.runtime.submit_agent")(
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
      const toolRetryPolicy = normalizeSubmitToolRetryPolicy(spec.budget?.toolRetryPolicy);
      const scope = spec.scope;
      const scopeRef = spec.scopeRef;
      const identity = {
        scopeRef,
        effectAuthorityRef: spec.effectAuthorityRef,
      } satisfies LedgerTruthIdentity;

      if (spec.resume !== undefined && spec.resume.turn.id !== spec.resume.runId) {
        return yield* Effect.fail(
          runtimeStorageError("submit", {
            reason: "resume_turn_run_mismatch",
            runId: spec.resume.runId,
            turn: spec.resume.turn,
          }),
        );
      }
      if (spec.resume !== undefined && options.productLink !== undefined) {
        return yield* Effect.fail(
          runtimeStorageError("submit", {
            reason: "product_link_excludes_resume",
            productLinkKind: options.productLink.kind,
          }),
        );
      }

      const priorEvents = spec.resume === undefined ? [] : yield* ledger.events(identity);
      let toolValidationFailures = 0;
      const startEvent = agentRunStartedEvent({
        ...identity,
        intent: spec.intent,
        executionIdentity: spec.executionIdentity,
        traceContext,
      });
      const started =
        spec.resume === undefined
          ? options.productLink === undefined
            ? (yield* appendRuntimeDriverAction(ledger, {
                kind: "start",
                event: startEvent,
              })).event
            : (yield* appendRuntimeDriverAction(ledger, {
                kind: "start_with_product_link",
                start: startEvent,
                productLink: (runId) =>
                  productLinkEventFor(options.productLink!, identity, runId, traceContext),
              })).event
          : priorEvents.find(
              (event) =>
                event.id === spec.resume?.runId &&
                event.kind === RUNTIME_EVENT_KIND.AGENT_RUN_STARTED,
            );
      if (started === undefined) {
        return yield* Effect.fail(
          runtimeStorageError("submit", {
            reason: "resume_missing_run_started",
            runId: spec.resume?.runId,
          }),
        );
      }
      const materialVersions = new Map<string, string>();
      for (const event of priorEvents) {
        const decoded = decodeRuntimeLedgerEvent(event);
        if (
          decoded._tag === "runtime" &&
          decoded.event.kind === RUNTIME_EVENT_KIND.AGENT_MATERIAL_RESOLVED &&
          decoded.event.payload.runId === started.id
        ) {
          materialVersions.set(decoded.event.payload.materialRef, decoded.event.payload.version);
        }
      }
      const recordMaterialResolutions = (
        receipts: ReadonlyArray<MaterialResolutionReceipt>,
      ): Effect.Effect<void, RuntimeStorageError | JsonStringifyError | RefResolutionFailed> =>
        Effect.gen(function* () {
          for (const receipt of receipts) {
            const key = materialRefKey(receipt.materialRef);
            const expectedVersion = materialVersions.get(key);
            if (expectedVersion !== undefined && expectedVersion !== receipt.version) {
              return yield* Effect.fail(
                new RefResolutionFailed({
                  kind: receipt.materialRef.kind,
                  ref: key,
                  reason: "material_version_mismatch",
                  expectedVersion,
                  actualVersion: receipt.version,
                }),
              );
            }
            if (expectedVersion !== undefined) continue;
            yield* appendRuntimeDriverAction(ledger, {
              kind: "resolve_material",
              event: agentMaterialResolvedEvent({
                ...identity,
                runId: started.id,
                materialRef: key,
                version: receipt.version,
              }),
            });
            materialVersions.set(key, receipt.version);
          }
        });
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
        const existingResult = projectSubmitResult(priorEvents, started.id);
        if (existingResult !== null && existingResult.status !== "interrupted")
          return existingResult;
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
        const attempted = yield* Effect.result(
          runTimedLlmAttempt(timeout, budgetTimeMs, (signal) =>
            admission.attemptStructured<unknown>({
              scope,
              route,
              schemaSpec,
              strategy: "forced-tool-call",
              traceContext,
              signal,
              stimulus: {
                kind: "live",
                userInput: { userText },
              },
            }),
          ),
        );
        if (attempted._tag === "Failure") {
          if (isLlmCallTimedOut(attempted.failure)) {
            return yield* timeoutAbortResult(
              attempted.failure,
              identity,
              started.id,
              tokensBeforeCall,
              traceContext,
            );
          }
          if (attempted.failure._tag === ABORT.UPSTREAM_FAILURE) {
            return yield* finalAbort(
              ABORT.UPSTREAM_FAILURE,
              { cause: publicRuntimeCauseReason(attempted.failure.cause) },
              identity,
              started.id,
              tokensBeforeCall,
              traceContext,
            );
          }
          return yield* Effect.fail(attempted.failure);
        }
        const result = attempted.success;

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

      const visibleTools = toolsForDynamicCapabilityProjection(
        spec.tools,
        spec.dynamicCapabilityProjection,
      );
      const dynamicInstructionFragments = instructionFragmentsForDynamicCapabilityProjection(
        spec.instructionFragments,
        spec.dynamicCapabilityProjection,
      );
      const dynamicSystem = systemWithDynamicInstructionFragments(
        spec.system,
        dynamicInstructionFragments,
      );

      const registry = validateToolRegistry(visibleTools);
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
      const policyToolNames = [...new Set([...requiredToolNames, ...completeAfterToolNames])];
      const orderedCompleteAfterTools =
        completeAfterToolsRequireInvocation(spec) &&
        spec.toolPolicy?.completeAfterToolsExecuted?.ordered === true;
      const unknownPolicyToolName = policyToolNames.find(
        (toolName) => visibleTools[toolName] === undefined,
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
      const domainRegistry = validateExecutionDomainRegistry(visibleTools, {
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

      const initialMessages = yield* buildInitialMessages({ ...spec, system: dynamicSystem });

      const loop: Effect.Effect<
        SubmitResult,
        | RuntimeStorageError
        | JsonStringifyError
        | UpstreamFailure
        | ToolError
        | RefResolutionFailed
        | BoundaryCommitRejected,
        | Ledger
        | BoundaryEvents
        | MaterializedProjections
        | LlmTransport
        | Quota
        | RefResolverService
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
          readonly didRedact: boolean;
        }): Effect.Effect<void, RuntimeStorageError | JsonStringifyError> =>
          Effect.gen(function* () {
            const compaction = compactProviderHistoryToolCall(
              messages,
              input.toolCallId,
              input.argumentsJson,
              input.didRedact,
            );
            if (compaction === null) return;
            if (input.sourceEventId === undefined) {
              return yield* Effect.fail(
                runtimeStorageError("submit", {
                  reason: "provider_history_compaction_missing_source_event",
                  runId: started.id,
                  turn: input.turn,
                  toolCallId: input.toolCallId,
                  toolName: input.toolName,
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
        let admittedResume: InputRequestResumePayload | undefined;
        let toolPolicyFailures = 0;
        const executedToolNames = new Set(
          policyToolNames.filter((toolName) => hasExecutedTool(priorEvents, started.id, toolName)),
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
          const runtimeInterruption =
            decodedInterruption._tag === "runtime" &&
            decodedInterruption.event.kind === RUNTIME_EVENT_KIND.AGENT_RUN_INTERRUPTED
              ? decodedInterruption.event
              : undefined;
          if (runtimeInterruption === undefined) {
            return yield* finalAbort(
              ABORT.TOOL_ERROR,
              {
                reason: "resume_matching_interruption_not_runtime",
                interruptId: resume.interruptId,
              },
              identity,
              started.id,
              0,
              traceContext,
            );
          }
          const decision = runtimeInterruption.payload.decision;
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
          const inputRequest = inputRequestRefFromInterruptedEvent(runtimeInterruption);
          if (!inputRequest.ok) {
            return yield* finalAbort(
              ABORT.TOOL_ERROR,
              {
                reason: inputRequest.reason,
                interruptId: resume.interruptId,
                gateRef: resume.gateRef,
              },
              identity,
              started.id,
              0,
              traceContext,
            );
          }
          const parsedResume = parseInputRequestResumePayload(
            inputRequest.ref.requestKind,
            resume.resume,
          );
          if (!parsedResume.ok) {
            return yield* finalAbort(
              ABORT.TOOL_ERROR,
              {
                reason: parsedResume.reason,
                interruptId: resume.interruptId,
                gateRef: resume.gateRef,
                requestKind: inputRequest.ref.requestKind,
              },
              identity,
              started.id,
              0,
              traceContext,
            );
          }
          const admittedResumeForDecision = parsedResume.resume;
          admittedResume = admittedResumeForDecision;

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
                  resume: admittedResumeForDecision,
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

            const toolDefs = toolDefinitionsForRuntimePolicy(
              visibleTools,
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
            const timedResp = yield* Effect.result(
              runTimedLlmAttempt(timeout, budgetTimeMs, (signal) =>
                llm.call(
                  {
                    route: spec.route,
                    messages,
                    tools: toolDefs.length > 0 ? toolDefs : undefined,
                    tool_choice: toolChoice,
                    traceContext,
                    continuationContext: {
                      truthIdentityFingerprint: backendProtocolTruthIdentityKey(identity),
                      turn: turnRefOf(started.id, turn),
                    },
                    materialResolution: {
                      truthIdentity: identity,
                      expectedVersions: Object.fromEntries(materialVersions),
                      onResolved: (receipt) =>
                        recordMaterialResolutions([receipt]).pipe(
                          Effect.mapError((failure) =>
                            failure instanceof RefResolutionFailed
                              ? failure
                              : new RefResolutionFailed({
                                  kind: receipt.materialRef.kind,
                                  ref: materialRefKey(receipt.materialRef),
                                  reason: "resolver_failed",
                                }),
                          ),
                        ),
                    },
                  },
                  { signal },
                ),
              ),
            );
            if (timedResp._tag === "Failure") {
              if (isLlmCallTimedOut(timedResp.failure)) {
                return yield* timeoutAbortResult(
                  timedResp.failure,
                  identity,
                  started.id,
                  tokensBeforeCall,
                  traceContext,
                );
              }
              return yield* Effect.fail(timedResp.failure);
            }
            const resp = timedResp.success;
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
                continuation:
                  resp.continuation === undefined
                    ? undefined
                    : resp.continuation.kind === "available"
                      ? markerFromProviderContinuation(resp.continuation.value)
                      : resp.continuation.marker,
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
              ...(resp.continuation?.kind !== "available"
                ? {}
                : { continuation: resp.continuation.value }),
            });

            if (nextResponseToolCalls.length === 0) {
              const remainingPolicyToolNames = remainingRequiredToolNames(
                requiredToolNames,
                executedToolNames,
              );
              if (remainingPolicyToolNames.length > 0) {
                if (toolPolicyFailures >= toolRetryPolicy.correctionRetries) {
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
            const tool = visibleTools[call.function.name];
            if (tool === undefined) {
              const hiddenTool = dynamicCapabilityToolVisibilityDenied(
                call.function.name,
                spec.tools,
                spec.dynamicCapabilityProjection,
              )
                ? spec.tools[call.function.name]
                : undefined;
              if (hiddenTool !== undefined) {
                const phasePolicyDiagnostic = dynamicCapabilityPhasePolicyDeniedDiagnostic(
                  call.function.name,
                  spec.dynamicCapabilityProjection,
                );
                const rejectionReason =
                  phasePolicyDiagnostic?.reason ?? DYNAMIC_TOOL_VISIBILITY_DENIED_REASON;
                const hiddenContract = hiddenTool.contract;
                const hiddenClaim = makePreClaim({
                  operationRef: makeOperationRef("tool", [scope, started.id, turn, call.id]),
                  scopeRef,
                  effectAuthorityRef: hiddenContract.effectAuthorityRef,
                  originRef: hiddenContract.originRef ?? {
                    originId: `run:${started.id}`,
                    originKind: "submit",
                  },
                });
                yield* appendRuntimeDriverAction(ledger, {
                  kind: "reject_tool",
                  event: toolRejectedEvent({
                    ...identity,
                    runId: started.id,
                    toolCallId: call.id,
                    name: call.function.name,
                    args: summarizeToolArguments(call.function.arguments),
                    execution: hiddenTool.execution,
                    claim: settleToolPolicyRejected(hiddenClaim, rejectionReason),
                    diagnostics: {
                      phase: "policy",
                      reason: rejectionReason,
                      ...(phasePolicyDiagnostic === undefined
                        ? {}
                        : {
                            source: phasePolicyDiagnostic.source,
                            toolName: call.function.name,
                            policyId: phasePolicyDiagnostic.policyId,
                            policyPhase: phasePolicyDiagnostic.phase,
                            requiredCategory: phasePolicyDiagnostic.requiredCategory,
                            ...(phasePolicyDiagnostic.category === undefined
                              ? {}
                              : { category: phasePolicyDiagnostic.category }),
                          }),
                      argumentSummary: summarizeToolArguments(call.function.arguments),
                    },
                    traceContext,
                  }),
                });
                return yield* new ToolError({
                  toolName: call.function.name,
                  cause: { reason: rejectionReason },
                });
              }
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
              if (toolPolicyFailures >= toolRetryPolicy.correctionRetries) {
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
                didRedact: false,
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
            const parsed = yield* Effect.result(
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
            if (parsed._tag === "Failure") {
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
              if (toolValidationFailures >= toolRetryPolicy.correctionRetries) {
                return yield* parsed.failure;
              }
              toolValidationFailures++;
              yield* recordProviderHistoryCompaction({
                turn: turnRefOf(started.id, turn),
                sourceEventId: responseToolCallSourceEventIds.get(call.id),
                toolCallId: call.id,
                toolName: call.function.name,
                argumentsJson: call.function.arguments,
                didRedact: false,
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
            const decoded = yield* Effect.result(
              decodeToolArgs(tool, parsed.success, call.function.name),
            );
            if (decoded._tag === "Failure") {
              const schemaIssues = schemaIssuesFromToolError(decoded.failure);
              yield* appendRuntimeDriverAction(ledger, {
                kind: "reject_tool",
                event: toolRejectedEvent({
                  ...identity,
                  runId: started.id,
                  toolCallId: call.id,
                  name: call.function.name,
                  args: summarizeToolArguments(parsed.success),
                  execution: tool.execution,
                  claim: settleToolValidationRejected(claim, "invalid_args"),
                  diagnostics: {
                    phase: "decode",
                    reason: "invalid_args",
                    argumentSummary: summarizeToolArguments(parsed.success),
                    ...(schemaIssues === undefined ? {} : { schemaIssues }),
                  },
                  traceContext,
                }),
              });
              if (toolValidationFailures >= toolRetryPolicy.correctionRetries) {
                return yield* decoded.failure;
              }
              toolValidationFailures++;
              yield* recordProviderHistoryCompaction({
                turn: turnRefOf(started.id, turn),
                sourceEventId: responseToolCallSourceEventIds.get(call.id),
                toolCallId: call.id,
                toolName: call.function.name,
                argumentsJson: call.function.arguments,
                didRedact: false,
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
            const args = decoded.success;

            const interrupt = decisionInterruptFor(spec, call.function.name);
            if (interrupt !== undefined && call.id !== resumedToolCallIdThisTurn) {
              const gateRef = decisionGateRefFor(interrupt, claim.operationRef);
              const interruptId = decisionInterruptIdFor(interrupt, claim.operationRef);
              const subjectRef = decisionSubjectRefFor(claim);
              const gateClaim = decisionGateClaimFor(spec, started.id, gateRef);
              yield* appendNextDriverAction(
                { ledger, boundaryEvents },
                {
                  kind: "park",
                  request: {
                    gateRef,
                    subjectRef,
                    ...(interrupt.policyRef === undefined
                      ? {}
                      : { policyRef: interrupt.policyRef }),
                    ...(interrupt.summary === undefined ? {} : { summary: interrupt.summary }),
                    claim: gateClaim,
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
              return yield* submitResultFromEvents(events, started.id);
            }

            const admissionProgram = yield* Effect.result(
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
              admissionProgram._tag === "Failure"
                ? {
                    ok: false as const,
                    rejectionRef: admissionProgram.failure,
                  }
                : yield* admissionProgram.success.pipe(
                    Effect.catchIf(
                      () => true,
                      (cause) =>
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

            const materialPlan = planToolMaterials(spec, tool, claim, resolvedExecution.resolved);
            if (!materialPlan.ok) {
              yield* appendRuntimeDriverAction(ledger, {
                kind: "reject_tool",
                event: toolRejectedEvent({
                  ...identity,
                  runId: started.id,
                  toolCallId: call.id,
                  name: call.function.name,
                  args: call.function.arguments,
                  execution: tool.execution,
                  claim: settleToolAdmissionRejected(claim, materialPlan.rejectionRef),
                  traceContext,
                }),
              });
              return yield* new ToolError({
                toolName: call.function.name,
                cause: toolAdmissionFailureCause(materialPlan.rejectionRef),
              });
            }

            // Grant + execute are inside retry, but quota grants are keyed by
            // the semantic tool claim operationRef. Retrying the same claim
            // cannot double-charge quota; separate tool calls still consume
            // separate quota.
            const attemptOnce: Effect.Effect<
              unknown,
              ToolError | RuntimeStorageError | JsonStringifyError | RefResolutionFailed
            > = Effect.gen(function* () {
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
                return yield* withLocalResolvedToolMaterials(
                  refs,
                  {
                    request: (materialRef) => {
                      const expectedVersion = materialVersions.get(materialRefKey(materialRef));
                      return {
                        truthIdentity: identity,
                        materialRef,
                        ...(expectedVersion === undefined ? {} : { expectedVersion }),
                      };
                    },
                    onResolved: (receipt) => recordMaterialResolutions([receipt]),
                  },
                  call.function.name,
                  materialPlan.plan.localRefs,
                  (localMaterials) =>
                    executeTool(
                      tool,
                      args,
                      call.function.name,
                      { ...materialPlan.plan.materials, ...localMaterials },
                      runtimeToolContext(
                        spec,
                        boundaryEvents,
                        projections,
                        claim,
                        call.id === resumedToolCallIdThisTurn ? admittedResume : undefined,
                        materialPlan.plan.brokerReceipts,
                        spec.runtimeGraphStatus,
                      ),
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
                Effect.timeoutOrElse({
                  duration: Duration.millis(remainingMs),
                  orElse: () =>
                    Effect.fail(
                      new ToolError({
                        toolName: call.function.name,
                        cause: toolBudgetTimeCause(budgetTimeMs, budgetTimeMs),
                      }),
                    ),
                }),
              );
            });

            const result = yield* attemptOnce.pipe(
              Effect.retry({
                schedule: toolRetryPolicy.executionRetrySchedule,
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
            if (policyToolNames.includes(call.function.name)) {
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
              argumentsJson: historyArguments.argumentsJson,
              didRedact: historyArguments.didRedact,
            });
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              name: call.function.name,
              content: resultStr,
            });
            if (
              completeAfterToolNames.length > 0 &&
              allPolicyToolsExecuted(policyToolNames, executedToolNames)
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
    }),
  );
