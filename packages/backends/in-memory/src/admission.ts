import { Clock, Effect, Layer } from "effect";
import { JsonStringifyError, UpstreamFailure } from "@agent-os/kernel/errors";
import {
  Admission,
  classifyStructuredCallFailure,
  decodeStructuredOutputFromItems,
  runtimeStorageError,
  runtimeStorageOrJsonError,
  structuredOutputRequest,
  type RuntimeStorageError,
} from "@agent-os/runtime";
import {
  decideTier,
  LLM_STRUCTURED_EVIDENCE_EVENT,
  LLM_STRUCTURED_INVALIDATE_EVENT,
  projectLease,
  type AdmissionImpact,
  type AdmissionRow,
  type AttemptKey,
  type AttemptResult,
  type AttemptSpec,
  type CapabilityLease,
  type InvalidateSpec,
  type Outcome,
} from "@agent-os/runtime-protocol";
import { LlmTransport, llmWireDescriptorFingerprint } from "@agent-os/llm-protocol";
import type { InMemoryBackendState } from "./state";
import { inMemoryConversationTruthIdentity, inMemoryRuntimeEventIdentity } from "./state";
import { decodeOk, recordOf } from "./decode";

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
): Effect.Effect<ReadonlyArray<AdmissionRow>, RuntimeStorageError> =>
  Effect.sync(() => {
    const eventIdentity = inMemoryRuntimeEventIdentity(inMemoryConversationTruthIdentity(scope));
    const rows: AdmissionRow[] = [];
    for (const event of state.eventSnapshot(eventIdentity)) {
      if (event.kind === LLM_STRUCTURED_EVIDENCE_EVENT) {
        const payload = recordOf(event.payload, event.kind);
        if (!payload.ok) return payload;
        rows.push({
          id: event.id,
          ts: event.ts,
          kind: LLM_STRUCTURED_EVIDENCE_EVENT,
          key: payload.value.key as AttemptKey,
          stimulusKind: payload.value.stimulusKind as "probe" | "live",
          outcome: payload.value.outcome as Outcome,
          admissionImpact: payload.value.admissionImpact as AdmissionImpact,
        });
      }
      if (event.kind === LLM_STRUCTURED_INVALIDATE_EVENT) {
        const payload = recordOf(event.payload, event.kind);
        if (!payload.ok) return payload;
        rows.push({
          id: event.id,
          ts: event.ts,
          kind: LLM_STRUCTURED_INVALIDATE_EVENT,
          key: payload.value.key as Partial<AttemptKey>,
        });
      }
    }
    return decodeOk(rows);
  }).pipe(
    Effect.flatMap((result) =>
      result.ok
        ? Effect.succeed(result.value)
        : Effect.fail(runtimeStorageError("admission", result.cause)),
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
        spec: AttemptSpec,
      ): Effect.Effect<
        AttemptResult<O>,
        RuntimeStorageError | JsonStringifyError | UpstreamFailure
      > =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const descriptor = yield* llm.resolveRoute(spec.route);
          const key: AttemptKey = {
            routeFingerprint: llmWireDescriptorFingerprint(descriptor.wireDescriptor),
            schemaFingerprint: spec.schemaSpec.fingerprint,
            strategy: spec.strategy,
            providerOutputAdapterVersion: descriptor.providerOutputAdapterVersion,
            transportAdapterVersion: descriptor.transportAdapterVersion,
          };
          const preRows = yield* projectAdmissionRows(state, spec.scope);
          const { lease: preLease, latestBarrier } = projectLease(preRows, key, now);
          if (preLease.status === "unsupported" && now < preLease.retryAfter) {
            return {
              ok: false as const,
              outcome: outcomeFromLease(preLease),
              lease: preLease,
              admissionImpact: "lease-bearing" as const,
              shortCircuited: true as const,
            };
          }

          const response = yield* Effect.result(
            llm.call(
              structuredOutputRequest({
                route: spec.route,
                schemaSpec: spec.schemaSpec,
                stimulus: spec.stimulus,
              }),
              { signal: spec.signal },
            ),
          );

          const decodedResult = yield* Effect.gen(function* () {
            if (response._tag === "Failure") {
              const classified = classifyStructuredCallFailure(response.failure);
              if (classified.kind === "fail_before_evidence") {
                return yield* Effect.fail(classified.failure);
              }
              return {
                decoded: undefined as O | undefined,
                outcome: classified.outcome,
              };
            }
            return yield* decodeStructuredOutputFromItems<O>({
              items: response.success.items,
              usage: response.success.usage,
              schemaSpec: spec.schemaSpec,
            }).pipe(
              Effect.map((decoded) =>
                decoded.ok
                  ? {
                      decoded: decoded.decoded,
                      outcome: {
                        class: "Supported" as const,
                        tokensUsed: decoded.tokensUsed,
                      } satisfies Outcome,
                    }
                  : {
                      decoded: undefined as O | undefined,
                      outcome: decoded.outcome,
                    },
              ),
            );
          });
          const { decoded, outcome } = decodedResult;

          const admissionImpact = decideTier(preLease, outcome, spec.stimulus.kind, latestBarrier);
          const evidencePayload = {
            key,
            stimulusKind: spec.stimulus.kind,
            outcome,
            admissionImpact,
            adapterId: descriptor.providerOutputAdapterId,
          };
          yield* state
            .commitEvents([
              {
                ts: now,
                kind: LLM_STRUCTURED_EVIDENCE_EVENT,
                ...inMemoryConversationTruthIdentity(spec.scope),
                payload: evidencePayload,
              },
            ])
            .pipe(Effect.mapError((cause) => runtimeStorageOrJsonError("admission", cause)));

          const postRows = yield* projectAdmissionRows(state, spec.scope);
          const { lease } = projectLease(postRows, key, now);
          if (outcome.class === "Supported" && decoded !== undefined) {
            return {
              ok: true as const,
              decoded,
              outcome,
              lease,
              admissionImpact,
              shortCircuited: false as const,
            };
          }
          return {
            ok: false as const,
            outcome,
            lease,
            admissionImpact,
            shortCircuited: false as const,
          };
        }).pipe(Effect.withSpan("agentos.in_memory.admission.attempt_structured"));

      const invalidate = (
        spec: InvalidateSpec,
      ): Effect.Effect<{ readonly barrierId: number }, RuntimeStorageError | JsonStringifyError> =>
        Effect.gen(function* () {
          const ts = yield* Clock.currentTimeMillis;
          const [event] = yield* state
            .commitEvents([
              {
                ts,
                kind: LLM_STRUCTURED_INVALIDATE_EVENT,
                ...inMemoryConversationTruthIdentity(spec.scope),
                payload: { key: spec.key, reason: spec.reason, by: spec.by },
              },
            ])
            .pipe(Effect.mapError((cause) => runtimeStorageOrJsonError("admission", cause)));
          return { barrierId: event!.id };
        }).pipe(Effect.withSpan("agentos.in_memory.admission.invalidate"));

      return { attemptStructured, invalidate };
    }),
  );
