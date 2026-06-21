import { Clock, Duration, Effect } from "effect";

import { validateRequest } from "./policy";
import {
  SandboxFailure,
  type SandboxBackend,
  type SandboxPolicy,
  SandboxPolicyDenied,
  type SandboxRunRequest,
  type SandboxRunSuccess,
} from "./types";

export const runSandbox = (
  backend: SandboxBackend,
  policy: SandboxPolicy,
  request: SandboxRunRequest,
): Effect.Effect<SandboxRunSuccess, SandboxFailure | SandboxPolicyDenied> =>
  Effect.withSpan("agentos.sandbox.run")(
    Effect.gen(function* () {
      yield* validateRequest(request);
      yield* policy({ request });
      const started = yield* Clock.currentTimeMillis;
      const result = yield* backend.run(request).pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(request.timeoutMs),
          orElse: () =>
            Effect.fail(
              new SandboxFailure({
                code: "Timeout",
                reason: `sandbox run exceeded ${request.timeoutMs}ms`,
              }),
            ),
        }),
      );
      const ended = yield* Clock.currentTimeMillis;
      return { ...result, durationMs: ended - started };
    }),
  );
