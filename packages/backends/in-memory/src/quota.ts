import { Clock, Effect, Layer } from "effect";
import { SqlError } from "@agent-os/kernel/errors";
import { Quota } from "@agent-os/runtime";
import { projectQuotaGrantUsage, QUOTA_EVENT_KIND, type GrantResult } from "@agent-os/backend-protocol";
import { inMemoryRuntimeEventIdentity, type InMemoryBackendState } from "./state";

export const InMemoryQuotaLive = (state: InMemoryBackendState): Layer.Layer<Quota> =>
  Layer.succeed(Quota, {
    tryGrant: (identity, key, amount, windowMs, limit, toolName, operationRef) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const eventIdentity = inMemoryRuntimeEventIdentity(identity);
        const windowStart = windowMs === Number.POSITIVE_INFINITY ? 0 : now - windowMs;
        const usage = yield* Effect.try({
          try: () =>
            projectQuotaGrantUsage(state.eventSnapshot(eventIdentity), {
              key,
              windowStart,
              operationRef,
            }),
          catch: (cause) => new SqlError({ cause }),
        });

        if (usage.alreadyGranted) {
          return { granted: true, consumed: usage.consumed, limit } satisfies GrantResult;
        }

        const consumed = usage.consumed;
        if (consumed + amount > limit) {
          yield* state.commitEvents([
            {
              ts: now,
              kind: QUOTA_EVENT_KIND.RATE_LIMITED,
              ...identity,
              payload: { key, attempted: amount, consumed, limit, windowMs, toolName },
            },
          ]);
          return { granted: false, consumed, limit } satisfies GrantResult;
        }

        yield* state.commitEvents([
          {
            ts: now,
            kind: QUOTA_EVENT_KIND.CONSUMED,
            ...identity,
            payload: { key, amount, toolName, operationRef },
          },
        ]);
        return { granted: true, consumed, limit } satisfies GrantResult;
      }),
  });
