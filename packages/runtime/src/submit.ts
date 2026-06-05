import type { LlmRoute } from "@agent-os/kernel/llm";
import type { Tool } from "@agent-os/kernel/tools";
import type { ScopeRef } from "@agent-os/kernel/effect-claim";
import type { AnyAgentSchemaSource } from "@agent-os/kernel/agent-schema";
import type { TraceContext } from "@agent-os/kernel/trace-context";

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
  readonly deliver: { readonly event: string };
}

export interface InternalSubmitSpec extends Omit<SubmitSpec, "deliver"> {
  readonly deliver: {
    readonly scope: string;
    readonly scopeRef: ScopeRef;
    readonly event: string;
  };
}

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
