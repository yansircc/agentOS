import { Clock, Effect, Layer } from "effect";
import { JsonStringifyError, SqlError } from "@agent-os/kernel/errors";
import {
  Admission,
  LlmTransport,
  decideTier,
  projectLease,
  routeFingerprint,
  validateAgainstSchema,
  type AdmissionImpact,
  type AdmissionRow,
  type AttemptKey,
  type AttemptResult,
  type AttemptSpec,
  type CapabilityLease,
  type InvalidateSpec,
  type Outcome,
} from "@agent-os/runtime";
import { describeDispatchCause } from "@agent-os/backend-protocol";
import type { InMemoryBackendState } from "./state";
import { decodeOk, recordOf } from "./decode";

const IN_MEMORY_ADAPTER_VERSION = "1.0.0";

const outcomeFromLease = (lease: CapabilityLease & { readonly status: "unsupported" }): Outcome => {
  switch (lease.failureClass) {
    case "BehaviorFailed":
      return { class: "BehaviorFailed", sampleDigest: "cached-short-circuit" };
    case "ProviderRejected":
      return { class: "ProviderRejected", status: 0, body: "cached-short-circuit" };
    case "SchemaUnsupported":
      return { class: "SchemaUnsupported", reason: "cached-short-circuit" };
    case "AuthError":
      return { class: "AuthError", status: 401 };
    case "RateLimited":
      return { class: "RateLimited" };
    case "TransientError":
      return { class: "TransientError", cause: "cached-short-circuit" };
    case "ConfigError":
      return { class: "ConfigError", reason: "cached-short-circuit" };
  }
};

const projectAdmissionRows = (
  state: InMemoryBackendState,
  scope: string,
): Effect.Effect<ReadonlyArray<AdmissionRow>, SqlError> =>
  Effect.sync(() => {
    const rows: AdmissionRow[] = [];
    for (const event of state.streamSnapshot(scope)) {
      if (event.kind === "llm.structured.evidence") {
        const payload = recordOf(event.payload, event.kind);
        if (!payload.ok) return payload;
        rows.push({
          id: event.id,
          ts: event.ts,
          kind: "llm.structured.evidence",
          key: payload.value.key as AttemptKey,
          stimulusKind: payload.value.stimulusKind as "probe" | "live",
          outcome: payload.value.outcome as Outcome,
          admissionImpact: payload.value.admissionImpact as AdmissionImpact,
        });
      }
      if (event.kind === "llm.structured.invalidate") {
        const payload = recordOf(event.payload, event.kind);
        if (!payload.ok) return payload;
        rows.push({
          id: event.id,
          ts: event.ts,
          kind: "llm.structured.invalidate",
          key: payload.value.key as Partial<AttemptKey>,
        });
      }
    }
    return decodeOk(rows);
  }).pipe(
    Effect.flatMap((result) =>
      result.ok ? Effect.succeed(result.value) : Effect.fail(new SqlError({ cause: result.cause })),
    ),
  );

export const InMemoryAdmissionLive = (
  state: InMemoryBackendState,
): Layer.Layer<Admission, never, LlmTransport> =>
  Layer.effect(
    Admission,
    Effect.gen(function* () {
      const llm = yield* LlmTransport;
      const attemptStructured = <O>(
        spec: AttemptSpec<O>,
      ): Effect.Effect<AttemptResult<O>, SqlError | JsonStringifyError> =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const key: AttemptKey = {
            routeFingerprint: routeFingerprint(spec.route),
            schemaFingerprint: spec.schemaContract.fingerprint,
            strategy: spec.strategy,
            adapterVersion: IN_MEMORY_ADAPTER_VERSION,
          };
          const preRows = yield* projectAdmissionRows(state, spec.scope);
          const { lease: preLease, latestBarrierTs } = projectLease(preRows, key, now);
          if (preLease.status === "unsupported" && now < preLease.retryAfter) {
            return {
              ok: false,
              outcome: outcomeFromLease(preLease),
              lease: preLease,
              admissionImpact: "lease-bearing",
              shortCircuited: true,
            };
          }

          const userContent =
            spec.stimulus.kind === "live"
              ? spec.stimulus.userInput.userText
              : JSON.stringify(spec.stimulus.synthetic);
          const response = yield* Effect.either(
            llm.call({
              route: spec.route,
              messages: [{ role: "user", content: userContent }],
            }),
          );

          const decodedResult =
            response._tag === "Left"
              ? yield* Effect.succeed({
                  decoded: undefined as O | undefined,
                  outcome: {
                    class: "TransientError" as const,
                    cause: describeDispatchCause(response.left),
                  } satisfies Outcome,
                })
              : yield* Effect.try({
                  try: () => JSON.parse(response.right.text) as O,
                  catch: (cause) => describeDispatchCause(cause),
                }).pipe(
                  Effect.map((parsed) => {
                    const violations = validateAgainstSchema(parsed, spec.schemaContract.schema);
                    if (violations.length > 0) {
                      return {
                        decoded: undefined,
                        outcome: {
                          class: "BehaviorFailed" as const,
                          sampleDigest: violations.join("|"),
                        } satisfies Outcome,
                      };
                    }
                    return {
                      decoded: parsed,
                      outcome: {
                        class: "Supported" as const,
                        tokensUsed: response.right.usage.totalTokens,
                      } satisfies Outcome,
                    };
                  }),
                  Effect.catchAll((sampleDigest) =>
                    Effect.succeed({
                      decoded: undefined as O | undefined,
                      outcome: {
                        class: "BehaviorFailed" as const,
                        sampleDigest,
                      } satisfies Outcome,
                    }),
                  ),
                );
          const { decoded, outcome } = decodedResult;

          const admissionImpact = decideTier(
            preLease,
            outcome,
            spec.stimulus.kind,
            latestBarrierTs,
          );
          const evidencePayload = {
            key,
            stimulusKind: spec.stimulus.kind,
            outcome,
            admissionImpact,
            adapterId: `in-memory@${IN_MEMORY_ADAPTER_VERSION}`,
          };
          const deliver =
            outcome.class === "Supported" && spec.stimulus.kind === "live" && decoded !== undefined
              ? spec.stimulus.deliver(decoded)
              : null;

          yield* state.commitEvents([
            {
              ts: now,
              kind: "llm.structured.evidence",
              scope: spec.scope,
              payload: evidencePayload,
            },
            ...(deliver === null
              ? []
              : [
                  {
                    ts: now,
                    kind: deliver.event,
                    scope: spec.scope,
                    payload: deliver.payload,
                  },
                ]),
          ]);

          const postRows = yield* projectAdmissionRows(state, spec.scope);
          const { lease } = projectLease(postRows, key, now);
          if (outcome.class === "Supported" && decoded !== undefined) {
            return {
              ok: true,
              decoded,
              outcome,
              lease,
              admissionImpact,
              shortCircuited: false,
            };
          }
          return {
            ok: false,
            outcome,
            lease,
            admissionImpact,
            shortCircuited: false,
          };
        });

      const invalidate = (
        spec: InvalidateSpec,
      ): Effect.Effect<{ readonly barrierId: number }, JsonStringifyError> =>
        Effect.gen(function* () {
          const ts = yield* Clock.currentTimeMillis;
          const [event] = yield* state.commitEvents([
            {
              ts,
              kind: "llm.structured.invalidate",
              scope: spec.scope,
              payload: { key: spec.key, reason: spec.reason, by: spec.by },
            },
          ]);
          return { barrierId: event!.id };
        });

      return { attemptStructured, invalidate };
    }),
  );
