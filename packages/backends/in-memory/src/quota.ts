import { Clock, Effect, Layer } from "effect";
import { SqlError } from "@agent-os/kernel/errors";
import type { LedgerEvent } from "@agent-os/kernel/types";
import { Quota, type GrantResult } from "@agent-os/runtime";
import type { InMemoryBackendState } from "./state";
import { decodeOk, finiteNumberField, recordOf, stringField, type DecodeResult } from "./decode";

const consumedAmount = (event: LedgerEvent, key: string): DecodeResult<number> => {
  const payloadResult = recordOf(event.payload, "dispatch.consumed");
  if (!payloadResult.ok) return payloadResult;
  const payload = payloadResult.value;
  const payloadKey = stringField(payload, "key");
  if (!payloadKey.ok) return payloadKey;
  const amount = finiteNumberField(payload, "amount");
  if (!amount.ok) return amount;
  const toolName = stringField(payload, "toolName");
  if (!toolName.ok) return toolName;
  return decodeOk(payloadKey.value === key ? amount.value : 0);
};

const consumedOperationRef = (event: LedgerEvent): DecodeResult<string | null> => {
  const payloadResult = recordOf(event.payload, "dispatch.consumed");
  if (!payloadResult.ok) return payloadResult;
  const value = payloadResult.value.operationRef;
  return decodeOk(typeof value === "string" ? value : null);
};

export const InMemoryQuotaLive = (state: InMemoryBackendState): Layer.Layer<Quota> =>
  Layer.succeed(Quota, {
    tryGrant: (scope, key, amount, windowMs, limit, toolName, operationRef) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const windowStart = windowMs === Number.POSITIVE_INFINITY ? 0 : now - windowMs;
        const usage = yield* Effect.sync(() => {
          let sum = 0;
          for (const event of state.streamSnapshot(scope)) {
            if (event.kind !== "dispatch.consumed" || event.ts < windowStart) continue;
            const eventOperationRef = consumedOperationRef(event);
            if (!eventOperationRef.ok) return eventOperationRef;
            if (eventOperationRef.value === operationRef) {
              return decodeOk({ consumed: sum, alreadyGranted: true });
            }
            const amountResult = consumedAmount(event, key);
            if (!amountResult.ok) return amountResult;
            sum += amountResult.value;
          }
          return decodeOk({ consumed: sum, alreadyGranted: false });
        }).pipe(
          Effect.flatMap((result) =>
            result.ok
              ? Effect.succeed(result.value)
              : Effect.fail(new SqlError({ cause: result.cause })),
          ),
        );

        if (usage.alreadyGranted) {
          return { granted: true, consumed: usage.consumed, limit } satisfies GrantResult;
        }

        const consumed = usage.consumed;
        if (consumed + amount > limit) {
          yield* state.commitEvents([
            {
              ts: now,
              kind: "dispatch.rate_limited",
              scope,
              payload: { key, attempted: amount, consumed, limit, windowMs, toolName },
            },
          ]);
          return { granted: false, consumed, limit } satisfies GrantResult;
        }

        yield* state.commitEvents([
          {
            ts: now,
            kind: "dispatch.consumed",
            scope,
            payload: { key, amount, toolName, operationRef },
          },
        ]);
        return { granted: true, consumed, limit } satisfies GrantResult;
      }),
  });
