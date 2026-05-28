import { Context, Effect } from "effect";
import type { RefResolutionFailed } from "@agent-os/kernel/ref-resolver";
import type { UpstreamFailure } from "@agent-os/kernel/errors";
import type { LlmRequest, LlmResponse } from "@agent-os/kernel/llm";

export class LlmTransport extends Context.Tag("@agent-os/LlmTransport")<
  LlmTransport,
  {
    readonly call: (
      request: LlmRequest,
    ) => Effect.Effect<LlmResponse, UpstreamFailure | RefResolutionFailed>;
  }
>() {}
