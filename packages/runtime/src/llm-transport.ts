import { Context, Effect } from "effect";
import type { UpstreamFailure } from "@agent-os/kernel/errors";
import type { LlmRequest, LlmResponse, LlmRoute, LlmWireDescriptor } from "@agent-os/llm-protocol";

export interface LlmCallOptions {
  readonly signal?: AbortSignal;
}

export interface LlmTransportRouteDescriptor {
  readonly wireDescriptor: LlmWireDescriptor;
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
    readonly resolveRoute: (
      route: LlmRoute,
    ) => Effect.Effect<LlmTransportRouteDescriptor, UpstreamFailure>;
    readonly call: (
      request: LlmRequest,
      options?: LlmCallOptions,
    ) => Effect.Effect<LlmResponse, UpstreamFailure>;
  }
>() {}
