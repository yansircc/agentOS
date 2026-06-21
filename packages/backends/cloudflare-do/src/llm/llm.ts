import { Effect, Layer } from "effect";
import { UpstreamFailure } from "@agent-os/kernel/errors";
import { LlmTransport } from "@agent-os/llm-protocol";
import type { RefResolverService } from "@agent-os/kernel/ref-resolver";

export type {
  LlmMessage,
  LlmOutputItem,
  LlmRequest,
  LlmResponse,
  LlmRoute,
  LlmToolCall,
  LlmUsage,
} from "@agent-os/llm-protocol";
export type { ToolDefinition } from "@agent-os/kernel/tools";
export {
  llmOutputItemsFromTextAndToolCalls,
  textFromLlmOutputItems,
  toolCallsFromLlmOutputItems,
} from "@agent-os/llm-protocol";

const missingLlmTransport = () =>
  new UpstreamFailure({ cause: { reason: "cloudflare_do_llm_transport_unbound" } });

export const MissingLlmTransportLive: Layer.Layer<LlmTransport, never, RefResolverService> =
  Layer.succeed(LlmTransport, {
    resolveRoute: () =>
      Effect.fail(missingLlmTransport()).pipe(
        Effect.withSpan("agentos.cloudflare_do.llm.missing.resolve_route"),
      ),
    call: () =>
      Effect.fail(missingLlmTransport()).pipe(
        Effect.withSpan("agentos.cloudflare_do.llm.missing.call"),
      ),
  });
