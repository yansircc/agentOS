import type { LlmRoute } from "@agent-os/llm-protocol";
import type { Tool, ToolExecutionContextInput } from "@agent-os/kernel/tools";
import type { AuthorityRef, ScopeRef } from "@agent-os/kernel/effect-claim";
import type { AnyAgentSchemaSource } from "@agent-os/kernel/agent-schema";
import type { TraceContext } from "@agent-os/telemetry-protocol";
import type { MaterialRef } from "@agent-os/kernel/material-ref";
import type { ResolvedMaterial } from "@agent-os/kernel/ref-resolver";
import type { BoundaryPackage } from "@agent-os/kernel/extensions";

export interface SubmitToolIntent {
  readonly kind: string;
  readonly boundaryPackage: BoundaryPackage;
}

export type SubmitToolContext = Pick<ToolExecutionContextInput, "extensions">;

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
  readonly resolvedMaterials?: Readonly<Record<string, ResolvedMaterial>>;
  readonly toolContext?: SubmitToolContext;
  readonly toolIntents?: ReadonlyArray<SubmitToolIntent>;
  readonly decisionInterrupts?: ReadonlyArray<SubmitDecisionInterrupt>;
  readonly resume?: SubmitResumeDecision;
}

export interface InternalSubmitSpec extends SubmitSpec {
  readonly scope: string;
  readonly scopeRef: ScopeRef;
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
