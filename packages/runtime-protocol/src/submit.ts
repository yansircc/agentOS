import type { LlmRoute } from "@agent-os/llm-protocol";
import type {
  ExecutionDomainDeclaration,
  Tool,
  ToolExecutionContextInput,
} from "@agent-os/kernel/tools";
import type { AuthorityRef } from "@agent-os/kernel/effect-claim";
import type { AnyAgentSchemaSource } from "@agent-os/kernel/agent-schema";
import type { TraceContext } from "@agent-os/telemetry-protocol";
import type { MaterialRef } from "@agent-os/kernel/material-ref";
import type { BoundaryPackage } from "@agent-os/kernel/extensions";
import type { ContinuationRef } from "./continuation";

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
   * This is a runtime-owned policy for workflows whose terminal fact depends on
   * a specific tool effect. It prevents pre-terminal prose from becoming the
   * effective output channel while still allowing read/inspect tools before the
   * terminal tool runs.
   */
  readonly requiredUntilToolExecuted?: {
    readonly toolName: string;
  };

  /**
   * Complete the submit run immediately after every listed tool has executed.
   *
   * Artifact-first workflows often use tool effects as the terminal evidence
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

/**
 * Runtime submit input for one agent run under an effect authority.
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
  readonly executionDomains?: ReadonlyArray<ExecutionDomainDeclaration>;
  readonly budget?: {
    readonly tokens?: number;
    readonly timeMs?: number;
    readonly maxTurns?: number;
    readonly toolRetries?: number;
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
  | (string & {});

export interface SubmitResumeDecision {
  readonly runId: number;
  readonly turn: TurnRef;
  readonly interruptId: string;
  readonly gateRef: string;
  readonly decisionRef: string;
  readonly resume: unknown;
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
    }
  | {
      readonly ok: false;
      readonly status: "failed";
      readonly runId: number;
      readonly reason: string;
      readonly eventCount: number;
      readonly tokensUsed: number;
    };

export interface TurnRef {
  readonly id: number;
  readonly index: number;
}
