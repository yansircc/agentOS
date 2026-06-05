import type { LlmRoute } from "@agent-os/kernel/llm";
import type { Tool } from "@agent-os/kernel/tools";
import type { AuthorityRef, ScopeRef } from "@agent-os/kernel/effect-claim";
import type { AnyAgentSchemaSource } from "@agent-os/kernel/agent-schema";
import type { TraceContext } from "@agent-os/kernel/trace-context";

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
}

export interface InternalSubmitSpec extends SubmitSpec {
  readonly scope: string;
  readonly scopeRef: ScopeRef;
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
      readonly runId: number;
      readonly final: string;
      readonly eventCount: number;
      readonly tokensUsed: number;
    }
  | {
      readonly ok: false;
      readonly runId: number;
      readonly reason: string;
      readonly eventCount: number;
      readonly tokensUsed: number;
    };

export interface TurnRef {
  readonly id: number;
  readonly index: number;
}
