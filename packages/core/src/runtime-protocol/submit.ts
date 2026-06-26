import { Data, Option, Predicate } from "effect";
import type { LlmRoute } from "@agent-os/core/llm-protocol";
import type {
  ExecutionDomainDeclaration,
  Tool,
  ToolExecutionContextInput,
} from "@agent-os/core/tools";
import type { AuthorityRef } from "@agent-os/core/effect-claim";
import type { AnyAgentSchemaSource } from "@agent-os/core/agent-schema";
import type { TraceContext } from "@agent-os/core/telemetry-protocol";
import type { MaterialRef } from "@agent-os/core/material-ref";
import type { BoundaryPackage } from "@agent-os/core/extensions";
import { recordedContinuationRefFromUnknown, type ContinuationRef } from "./continuation";
import {
  inputRequestDescriptorFromUnknown,
  type InputRequestDescriptor,
  type InputRequestResumePayload,
} from "./input-request";
import type { ExecutionIdentity } from "./execution-identity";
import type { DynamicCapabilityProjection } from "./capability";

export class MissingSubmitRunBinding extends Data.TaggedError(
  "agent_os.missing_submit_run_binding",
)<{
  readonly bindingKind: "llm_route";
  readonly bindingRef: string;
}> {}

export interface SubmitToolIntent {
  readonly kind: string;
  readonly boundaryPackage: BoundaryPackage;
}

export interface SubmitReceiptBackedToolBinding {
  readonly kind: "intent_projection";
  readonly intentKinds: ReadonlyArray<string>;
}

export type SubmitToolContext = Pick<ToolExecutionContextInput, "extensions">;

export interface SubmitToolPolicy {
  /**
   * Force each LLM turn to return a tool call until this tool has executed.
   *
   * This is a runtime-owned policy for runs whose terminal fact depends on a
   * specific tool effect. It prevents pre-terminal prose from becoming the
   * effective output channel while still allowing read/inspect tools before the
   * terminal tool runs.
   */
  readonly requiredUntilToolExecuted?: {
    readonly toolName: string;
  };

  /**
   * Complete the submit run immediately after every listed tool has executed.
   *
   * Artifact-first submissions often use tool effects as the terminal evidence
   * and do not need one more model prose turn after the files are written. The
   * runtime treats these tools as required until they execute, then commits the
   * run completion fact without another LLM call.
   */
  readonly completeAfterToolsExecuted?: {
    readonly toolNames: ReadonlyArray<string>;
    /**
     * Treat toolNames as a listed sequence after the model starts terminal
     * artifact writes. Non-policy tools may still run before the first listed
     * tool; listed tools themselves must execute in order.
     */
    readonly ordered?: boolean;
    readonly finalMessage?: string;
  };
}

export type SubmitToolRetryDelayPolicy =
  | {
      readonly kind: "none";
    }
  | {
      readonly kind: "fixed";
      readonly delayMs: number;
      readonly jitter?: boolean;
    }
  | {
      readonly kind: "exponential";
      readonly baseDelayMs: number;
      readonly factor?: number;
      readonly jitter?: boolean;
    };

export interface SubmitToolExecutionRetryPolicy {
  readonly maxRetries?: number;
  readonly delay?: SubmitToolRetryDelayPolicy;
}

export interface SubmitToolRetryPolicy {
  readonly correctionRetries?: number;
  readonly execution?: SubmitToolExecutionRetryPolicy;
}

/**
 * App-authored submit input for one agent run.
 *
 * This is the narrow shape produced by app-facing adapters. It intentionally
 * cannot provide route, tool registry, execution domains, or effect authority;
 * those facts are supplied by framework-owned bindings during lowering.
 *
 * @public
 */
export interface SubmitRunInput {
  readonly intent: string;
  readonly context: Record<string, unknown>;
  readonly system?: string;
  readonly budget?: {
    readonly tokens?: number;
    readonly timeMs?: number;
    readonly llmCallTimeoutMs?: number;
    readonly maxTurns?: number;
    readonly toolRetryPolicy?: SubmitToolRetryPolicy;
  };
  readonly outputSchema?: AnyAgentSchemaSource;
  readonly traceContext?: TraceContext;
  readonly materials?: Readonly<Record<string, MaterialRef>>;
  readonly toolContext?: SubmitToolContext;
  readonly toolPolicy?: SubmitToolPolicy;
  readonly decisionInterrupts?: ReadonlyArray<SubmitDecisionInterrupt>;
  readonly resume?: SubmitResumeDecision;
}

export interface SubmitRunBindings {
  readonly llmRoutes?: Readonly<Record<string, LlmRoute>>;
  readonly tools?: Readonly<Record<string, Tool>>;
  readonly dynamicCapabilityProjection?: DynamicCapabilityProjection;
  readonly instructionFragments?: ReadonlyArray<SubmitInstructionFragment>;
  readonly executionDomains?: ReadonlyArray<ExecutionDomainDeclaration>;
  readonly materials?: Readonly<Record<string, MaterialRef>>;
  readonly toolContext?: SubmitToolContext;
  readonly toolIntents?: ReadonlyArray<SubmitToolIntent>;
  readonly receiptBackedTools?: Readonly<Record<string, SubmitReceiptBackedToolBinding>>;
  readonly decisionInterrupts?: ReadonlyArray<SubmitDecisionInterrupt>;
  readonly executionIdentity?: ExecutionIdentity;
}

export interface LowerSubmitRunInputSpec {
  readonly input: SubmitRunInput;
  readonly bindings: SubmitRunBindings;
  readonly routeBindingRef?: string;
  readonly effectAuthorityRef: AuthorityRef;
}

const mergeSubmitToolContext = (
  base: SubmitToolContext | undefined,
  input: SubmitToolContext | undefined,
): SubmitToolContext | undefined => {
  const extensions = {
    ...base?.extensions,
    ...input?.extensions,
  };
  return Object.keys(extensions).length === 0 ? undefined : { extensions };
};

const lowerSubmitBudget = (
  budget: SubmitRunInput["budget"] | undefined,
): SubmitSpec["budget"] | undefined => {
  if (budget === undefined) return undefined;
  const lowered: NonNullable<SubmitSpec["budget"]> = {
    ...(budget.tokens === undefined ? {} : { tokens: budget.tokens }),
    ...(budget.timeMs === undefined ? {} : { timeMs: budget.timeMs }),
    ...(budget.llmCallTimeoutMs === undefined ? {} : { llmCallTimeoutMs: budget.llmCallTimeoutMs }),
    ...(budget.maxTurns === undefined ? {} : { maxTurns: budget.maxTurns }),
    ...(budget.toolRetryPolicy === undefined ? {} : { toolRetryPolicy: budget.toolRetryPolicy }),
  };
  return Object.keys(lowered).length === 0 ? undefined : lowered;
};

const mergeSubmitDecisionInterrupts = (
  bindings: SubmitRunBindings["decisionInterrupts"],
  input: SubmitRunInput["decisionInterrupts"],
): SubmitSpec["decisionInterrupts"] | undefined => {
  if (bindings === undefined && input === undefined) return undefined;
  const merged: SubmitDecisionInterrupt[] = [];
  const seenToolNames = new Set<string>();
  for (const interrupt of [...(bindings ?? []), ...(input ?? [])]) {
    if (seenToolNames.has(interrupt.toolName)) continue;
    seenToolNames.add(interrupt.toolName);
    merged.push(interrupt);
  }
  return merged.length === 0 ? undefined : merged;
};

/**
 * Framework-owned lowering from app-authored input plus pre-runtime bindings to
 * the full runtime driver input.
 *
 * @public
 */
export const lowerSubmitRunInput = (spec: LowerSubmitRunInputSpec): SubmitSpec => {
  const routeBindingRef = spec.routeBindingRef ?? "default";
  const route = spec.bindings.llmRoutes?.[routeBindingRef];
  if (route === undefined) {
    return Option.getOrThrowWith(
      Option.none(),
      () =>
        new MissingSubmitRunBinding({
          bindingKind: "llm_route",
          bindingRef: routeBindingRef,
        }),
    );
  }
  const toolContext = mergeSubmitToolContext(spec.bindings.toolContext, spec.input.toolContext);
  const budget = lowerSubmitBudget(spec.input.budget);
  const decisionInterrupts = mergeSubmitDecisionInterrupts(
    spec.bindings.decisionInterrupts,
    spec.input.decisionInterrupts,
  );
  return {
    intent: spec.input.intent,
    context: spec.input.context,
    ...(spec.input.system === undefined ? {} : { system: spec.input.system }),
    route,
    tools: { ...spec.bindings.tools },
    ...(spec.bindings.dynamicCapabilityProjection === undefined
      ? {}
      : { dynamicCapabilityProjection: spec.bindings.dynamicCapabilityProjection }),
    ...(spec.bindings.instructionFragments === undefined
      ? {}
      : { instructionFragments: spec.bindings.instructionFragments }),
    ...(spec.bindings.executionDomains === undefined
      ? {}
      : { executionDomains: spec.bindings.executionDomains }),
    ...(budget === undefined ? {} : { budget }),
    ...(spec.input.outputSchema === undefined ? {} : { outputSchema: spec.input.outputSchema }),
    ...(spec.input.traceContext === undefined ? {} : { traceContext: spec.input.traceContext }),
    effectAuthorityRef: spec.effectAuthorityRef,
    materials: { ...spec.bindings.materials, ...spec.input.materials },
    ...(toolContext === undefined ? {} : { toolContext }),
    ...(spec.bindings.toolIntents === undefined ? {} : { toolIntents: spec.bindings.toolIntents }),
    ...(spec.bindings.receiptBackedTools === undefined
      ? {}
      : { receiptBackedTools: spec.bindings.receiptBackedTools }),
    ...(spec.input.toolPolicy === undefined ? {} : { toolPolicy: spec.input.toolPolicy }),
    ...(decisionInterrupts === undefined ? {} : { decisionInterrupts }),
    ...(spec.input.resume === undefined ? {} : { resume: spec.input.resume }),
    ...(spec.bindings.executionIdentity === undefined
      ? {}
      : { executionIdentity: spec.bindings.executionIdentity }),
  };
};

/**
 * Runtime driver input for one agent run under an effect authority.
 *
 * @agentosPrimitive primitive.runtime.SubmitSpec
 * @agentosInvariant invariant.d10.truth-identity
 * @agentosDocs docs/tutorials/streaming-chatbot.md
 * @public
 */
export interface SubmitSpec {
  readonly intent: string;
  readonly context: Record<string, unknown>;
  readonly system?: string;
  readonly route: LlmRoute;
  readonly tools: Record<string, Tool>;
  readonly dynamicCapabilityProjection?: DynamicCapabilityProjection;
  readonly instructionFragments?: ReadonlyArray<SubmitInstructionFragment>;
  readonly executionDomains?: ReadonlyArray<ExecutionDomainDeclaration>;
  readonly budget?: {
    readonly tokens?: number;
    readonly timeMs?: number;
    /**
     * Maximum wall-clock time for each individual LLM provider call.
     *
     * This is intentionally separate from timeMs: timeMs bounds the whole run,
     * while llmCallTimeoutMs bounds one provider request. Runtime uses the
     * smaller of remaining run time and this call timeout.
     */
    readonly llmCallTimeoutMs?: number;
    readonly maxTurns?: number;
    readonly toolRetryPolicy?: SubmitToolRetryPolicy;
  };
  readonly outputSchema?: AnyAgentSchemaSource;
  readonly traceContext?: TraceContext;
  readonly effectAuthorityRef: AuthorityRef;
  readonly materials?: Readonly<Record<string, MaterialRef>>;
  readonly toolContext?: SubmitToolContext;
  readonly toolIntents?: ReadonlyArray<SubmitToolIntent>;
  readonly receiptBackedTools?: Readonly<Record<string, SubmitReceiptBackedToolBinding>>;
  readonly toolPolicy?: SubmitToolPolicy;
  readonly decisionInterrupts?: ReadonlyArray<SubmitDecisionInterrupt>;
  readonly resume?: SubmitResumeDecision;
  readonly executionIdentity?: ExecutionIdentity;
}

export interface SubmitInstructionFragment {
  readonly id: string;
  readonly digest: string;
  readonly text: string;
}

export interface SubmitDecisionInterrupt {
  readonly toolName: string;
  readonly reason: SubmitDecisionInterruptReason;
  readonly policyRef?: string;
  readonly summary?: string;
  readonly gateRefPrefix?: string;
  readonly interruptIdPrefix?: string;
  readonly resumeSchema?: unknown;
}

export type SubmitDecisionInterruptReason =
  | "approval_required"
  | "user_input_required"
  | "authorization_required"
  | (string & {});

export interface SubmitResumeDecision {
  readonly runId: number;
  readonly turn: TurnRef;
  readonly interruptId: string;
  readonly gateRef: string;
  readonly decisionRef: string;
  readonly resume: InputRequestResumePayload;
}

/**
 * Terminal return projection reconstructed from runtime ledger facts.
 *
 * @agentosPrimitive primitive.runtime.SubmitResult
 * @agentosInvariant invariant.d10.truth-identity
 * @agentosDocs docs/concepts/durable-truth.md
 * @public
 */
export type SubmitResult =
  | {
      readonly ok: true;
      readonly status: "delivered";
      readonly runId: number;
      readonly final: string;
      readonly eventCount: number;
      readonly tokensUsed: number;
    }
  | {
      readonly ok: false;
      readonly status: "interrupted";
      readonly runId: number;
      readonly reason: "interrupted";
      readonly eventCount: number;
      readonly tokensUsed: number;
      readonly interruptId: string;
      readonly turn: TurnRef;
      readonly gateRef: string;
      readonly continuation: ContinuationRef;
      readonly inputRequest?: InputRequestDescriptor;
    }
  | {
      readonly ok: false;
      readonly status: "failed";
      readonly runId: number;
      readonly reason: string;
      readonly eventCount: number;
      readonly tokensUsed: number;
    }
  | {
      readonly ok: false;
      readonly status: "aborted";
      readonly runId: number;
      readonly reason: "rejected" | "cancelled" | "expired";
      readonly eventCount: number;
      readonly tokensUsed: number;
    };

export interface TurnRef {
  readonly id: number;
  readonly index: number;
}

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1;

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isTurnRef = (value: unknown): value is TurnRef =>
  Predicate.isObject(value) && isPositiveInteger(value.id) && isNonNegativeInteger(value.index);

const turnRefsEqual = (left: TurnRef, right: TurnRef): boolean =>
  left.id === right.id && left.index === right.index;

export const decodeSubmitResult = (value: unknown): SubmitResult | null => {
  if (!Predicate.isObject(value)) return null;
  if (
    !isPositiveInteger(value.runId) ||
    !isNonNegativeInteger(value.eventCount) ||
    !isNonNegativeInteger(value.tokensUsed)
  ) {
    return null;
  }
  if (value.ok === true && value.status === "delivered") {
    return typeof value.final === "string"
      ? {
          ok: true,
          status: "delivered",
          runId: value.runId,
          final: value.final,
          eventCount: value.eventCount,
          tokensUsed: value.tokensUsed,
        }
      : null;
  }
  if (value.ok === false && value.status === "failed") {
    return typeof value.reason === "string"
      ? {
          ok: false,
          status: "failed",
          runId: value.runId,
          reason: value.reason,
          eventCount: value.eventCount,
          tokensUsed: value.tokensUsed,
        }
      : null;
  }
  if (value.ok === false && value.status === "aborted") {
    return value.reason === "rejected" || value.reason === "cancelled" || value.reason === "expired"
      ? {
          ok: false,
          status: "aborted",
          runId: value.runId,
          reason: value.reason,
          eventCount: value.eventCount,
          tokensUsed: value.tokensUsed,
        }
      : null;
  }
  if (value.ok !== false || value.status !== "interrupted") return null;
  if (
    value.reason !== "interrupted" ||
    !isNonEmptyString(value.interruptId) ||
    !isNonEmptyString(value.gateRef) ||
    !isTurnRef(value.turn)
  ) {
    return null;
  }
  const continuation = recordedContinuationRefFromUnknown(value.continuation);
  if (continuation === null) return null;
  if (
    continuation.runId !== value.runId ||
    !turnRefsEqual(continuation.turn, value.turn) ||
    continuation.interruptId !== value.interruptId ||
    continuation.gateRef !== value.gateRef
  ) {
    return null;
  }
  let inputRequest: InputRequestDescriptor | undefined;
  if (value.inputRequest !== undefined) {
    const parsedInputRequest = inputRequestDescriptorFromUnknown(value.inputRequest);
    if (parsedInputRequest === null) return null;
    if (
      parsedInputRequest.ref.runId !== value.runId ||
      !turnRefsEqual(parsedInputRequest.ref.turn, value.turn) ||
      parsedInputRequest.ref.interruptId !== value.interruptId ||
      parsedInputRequest.ref.gateRef !== value.gateRef
    ) {
      return null;
    }
    inputRequest = parsedInputRequest;
  }
  return {
    ok: false,
    status: "interrupted",
    runId: value.runId,
    reason: "interrupted",
    eventCount: value.eventCount,
    tokensUsed: value.tokensUsed,
    interruptId: value.interruptId,
    turn: value.turn,
    gateRef: value.gateRef,
    continuation,
    ...(inputRequest === undefined ? {} : { inputRequest }),
  };
};
