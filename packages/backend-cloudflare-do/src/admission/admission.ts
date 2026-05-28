/**
 * Admission orchestration — contract attemptStructured + invalidate.
 *
 * Algebra:
 *   attemptStructured(scope, route, schema, strategy, stimulus)
 *     → 1. project lease (read events, no writes)
 *     → 2. gate: if cached unsupported and not expired → short-circuit
 *     → 3. adapter.encode → ai.run → adapter.decode | adapter.classify
 *     → 4. decideTier(preLease, outcome, stimulusKind, latestBarrierTs)
 *     → 5. transactionSync(evidence row + optional deliver row)
 *     → 6. fire EventBus
 *
 * State ownership (contract §2 + contract §3.1):
 *   `events.kind = 'llm.structured.evidence'`   sole admission evidence writer
 *   `events.kind = 'llm.structured.invalidate'` sole barrier writer
 *   CapabilityLease, latestBarrierTs            pure projection over events
 *
 * No separate `leases` table. No KV cache. No second writer.
 *
 */

import { Clock, Effect, Layer, Schema } from "effect";
import {
  Admission,
  type AttemptKey,
  type AttemptResult,
  type AttemptSpec,
  type CapabilityLease,
  type DecodedOutput,
  type DeliverSpec,
  type InvalidateSpec,
  type Outcome,
} from "@agent-os/runtime";
import { EventBus } from "../ledger";
import { fireLedgerEvents, insertLedgerEvent } from "../ledger/inserted-events";
import { JsonStringifyError, SqlError, safeStringify } from "@agent-os/kernel/errors";
import { RefResolutionFailed, RefResolverService } from "@agent-os/kernel/ref-resolver";
import { AiBinding, dispatchProvider } from "../llm";
import { getProtocolAdapter, llmProtocolAdapters } from "../llm/protocol/protocol-adapter";

import { decideTier, projectLease } from "./lease";
import { routeFingerprint } from "./fingerprint";
import { loadAdmissionRows } from "./payload";

// Note: these symbols were historically owned by admission.ts. They now
// live in protocol/protocol-adapter.ts (contract elevation). Re-exported
// here so callers that import from "./admission" keep working.
export { ADAPTER_VERSION } from "../llm/protocol/protocol-adapter";
export type { AdapterMode } from "../llm/protocol/protocol-adapter";

const reconstructOutcomeFromLease = (
  lease: CapabilityLease & { status: "unsupported" },
): Outcome => {
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

// Schema unused — silence the unused-import warning while keeping the
// import statement so a future refactor that needs a Schema-derived
// type lights up at compile time instead of needing a stray edit. The
// pattern matches admission/payload.ts which owns the Schema surface.
void Schema;

export const AdmissionLive = (
  ctx: DurableObjectState,
): Layer.Layer<Admission, never, EventBus | AiBinding | RefResolverService> =>
  Layer.scoped(
    Admission,
    Effect.gen(function* () {
      const sql = ctx.storage.sql;
      const bus = yield* EventBus;
      const ai = yield* AiBinding;
      const resolver = yield* RefResolverService;

      const attemptStructured = <O>(
        spec: AttemptSpec<O>,
      ): Effect.Effect<AttemptResult<O>, SqlError | JsonStringifyError> =>
        Effect.gen(function* () {
          const adapterMode = spec.adapterMode ?? "production";
          const now = yield* Clock.currentTimeMillis;
          const key: AttemptKey = {
            routeFingerprint: routeFingerprint(spec.route),
            schemaFingerprint: spec.schemaContract.fingerprint,
            strategy: spec.strategy,
            adapterVersion: llmProtocolAdapters[spec.route.kind].version,
          };

          // Step 2: project lease.
          const rows = yield* loadAdmissionRows(sql, spec.scope);
          const { lease: preLease, latestBarrierTs } = projectLease(rows, key, now);

          // Step 3: gate.
          if (preLease.status === "unsupported" && now < preLease.retryAfter) {
            return {
              ok: false,
              outcome: reconstructOutcomeFromLease(preLease),
              lease: preLease,
              admissionImpact: "lease-bearing" as const,
              shortCircuited: true,
            };
          }

          // Step 4: encode (pure).
          const adapterStim =
            spec.stimulus.kind === "live"
              ? { kind: "live" as const, userInput: spec.stimulus.userInput }
              : { kind: "probe" as const, synthetic: spec.stimulus.synthetic };

          // v0.2.13: pick adapter by route.kind, dispatch transport via
          // dispatchProvider. evidence is tagged with the chosen
          // adapter's identity (cf-ai-binding@X vs openai-chat-compatible@X),
          // so routeFingerprint and adapterId always agree on which
          // protocol actually served the call.
          const adapter = getProtocolAdapter(spec.route.kind);
          const body = adapter.encodeStructured(
            spec.route as never,
            spec.schemaContract,
            adapterStim,
            spec.strategy,
          );

          // Step 5-6: call provider + decode (or classify error).
          const rawEither = yield* Effect.either(
            dispatchProvider(spec.route, body).pipe(
              Effect.provideService(AiBinding, ai),
              Effect.provideService(RefResolverService, resolver),
            ),
          );

          let outcome: Outcome;
          let decoded: DecodedOutput | undefined;

          if (rawEither._tag === "Left") {
            if (rawEither.left instanceof RefResolutionFailed) {
              outcome = {
                class: "ConfigError",
                reason: `${rawEither.left.kind}:${rawEither.left.ref}`,
              };
            } else {
              outcome = adapter.classify(rawEither.left);
            }
          } else {
            const d = adapter.decodeStructured(
              { raw: rawEither.right },
              spec.schemaContract,
              spec.strategy,
              adapterMode,
            );
            if (d.ok) {
              decoded = d.decoded;
              outcome = { class: "Supported", tokensUsed: d.tokensUsed };
            } else {
              outcome = d.outcome;
            }
          }

          // Step 7: admission impact from pre-call inputs only.
          const admissionImpact = decideTier(
            preLease,
            outcome,
            spec.stimulus.kind,
            latestBarrierTs,
          );

          // Step 8: pre-stringify payloads outside the transaction.
          const evidencePayload = {
            key,
            stimulusKind: spec.stimulus.kind,
            outcome,
            admissionImpact,
            adapterId: `${adapter.kind}@${adapter.version}`,
          };
          const evidenceStr = yield* safeStringify(evidencePayload);

          let deliverSpec: DeliverSpec | null = null;
          let deliverStr: string | null = null;
          if (
            outcome.class === "Supported" &&
            spec.stimulus.kind === "live" &&
            decoded !== undefined
          ) {
            deliverSpec = spec.stimulus.deliver(decoded as O);
            deliverStr = yield* safeStringify(deliverSpec.payload);
          }

          // Step 8b: transactionSync(evidence + optional deliver).
          const txResult = yield* Effect.try({
            try: () =>
              ctx.storage.transactionSync(() => {
                const evidenceEvent = insertLedgerEvent(sql, {
                  ts: now,
                  kind: "llm.structured.evidence",
                  scope: spec.scope,
                  payloadStr: evidenceStr,
                  payload: evidencePayload,
                });

                const events = [evidenceEvent];
                if (deliverSpec !== null && deliverStr !== null) {
                  events.push(
                    insertLedgerEvent(sql, {
                      ts: now,
                      kind: deliverSpec.event,
                      scope: spec.scope,
                      payloadStr: deliverStr,
                      payload: deliverSpec.payload,
                    }),
                  );
                }
                return { evidenceId: evidenceEvent.id, events };
              }),
            catch: (cause) => new SqlError({ cause }),
          });

          // Step 9: fire inserted ledger rows after commit.
          yield* fireLedgerEvents(bus, txResult.events);

          // Post-projection (read-only, for the return value's lease shape).
          const postRows = yield* loadAdmissionRows(sql, spec.scope);
          const { lease: postLease } = projectLease(postRows, key, now);

          if (outcome.class === "Supported" && decoded !== undefined) {
            return {
              ok: true,
              decoded: decoded as O,
              outcome,
              lease: postLease,
              admissionImpact,
              shortCircuited: false,
            };
          }
          return {
            ok: false,
            outcome,
            lease: postLease,
            admissionImpact,
            shortCircuited: false,
          };
        });

      const invalidate = (
        spec: InvalidateSpec,
      ): Effect.Effect<{ readonly barrierId: number }, SqlError | JsonStringifyError> =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const payload = {
            key: spec.key,
            reason: spec.reason,
            by: spec.by,
          };
          const payloadStr = yield* safeStringify(payload);

          const event = yield* Effect.try({
            try: () => {
              return insertLedgerEvent(sql, {
                ts: now,
                kind: "llm.structured.invalidate",
                scope: spec.scope,
                payloadStr,
                payload,
              });
            },
            catch: (cause) => new SqlError({ cause }),
          });

          yield* fireLedgerEvents(bus, [event]);

          return { barrierId: event.id };
        });

      return { attemptStructured, invalidate };
    }),
  );
