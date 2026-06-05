import { Context, Effect } from "effect";
import type { RefResolutionFailed } from "@agent-os/kernel/ref-resolver";
import type { UpstreamFailure } from "@agent-os/kernel/errors";
import type { LlmRequest, LlmResponse, LlmRoute } from "@agent-os/kernel/llm";

export interface LlmCallOptions {
  readonly signal?: AbortSignal;
}

export interface LlmTransportRouteDescriptor {
  readonly providerOutputAdapterId: string;
  readonly providerOutputAdapterVersion: string;
  readonly transportAdapterId: string;
  readonly transportAdapterVersion: string;
}

/**
 * Provider transport boundary for runtime LLM calls.
 *
 * @agentosPrimitive primitive.runtime.LlmTransport
 * @agentosInvariant invariant.boundary.runtime-validation-external-only
 * @agentosDocs docs/packages/llm-transport-effect-ai.md
 * @public
 */
export class LlmTransport extends Context.Tag("@agent-os/LlmTransport")<
  LlmTransport,
  {
    readonly describeRoute: (route: LlmRoute) => LlmTransportRouteDescriptor;
    readonly call: (
      request: LlmRequest,
      options?: LlmCallOptions,
    ) => Effect.Effect<LlmResponse, UpstreamFailure | RefResolutionFailed>;
  }
>() {}
