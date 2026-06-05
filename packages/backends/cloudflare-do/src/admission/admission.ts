/**
 * Admission orchestration — contract attemptStructured + invalidate.
 *
 * Algebra:
 *   attemptStructured(scope, route, schema, strategy, stimulus)
 *     → 1. project lease (read events, no writes)
 *     → 2. gate: if cached unsupported and not expired → short-circuit
 *     → 3. adapter.encode → ai.run → adapter.decode | adapter.classify
 *     → 4. decideTier(preLease, outcome, stimulusKind, latestBarrier)
 *     → 5. transactionSync(evidence row)
 *
 * State ownership (contract §2 + contract §3.1):
 *   `events.kind = 'llm.structured.evidence'`   sole admission evidence writer
 *   `events.kind = 'llm.structured.invalidate'` sole barrier writer
 *   CapabilityLease, latestBarrier              pure projection over events
 *
 * No separate `leases` table. No KV cache. No second writer.
 *
 */

import { Clock, Effect, Layer } from "effect";
import {
  Admission,
  LlmTransport,
  classifyStructuredCallFailure,
  decideTier,
  projectLease,
  routeFingerprint,
  structuredOutputRequest,
  type AttemptKey,
  type AttemptResult,
  type AttemptSpec,
  type CapabilityLease,
  type DecodedOutput,
  type InvalidateSpec,
  type Outcome,
  decodeStructuredOutputFromItems,
} from "@agent-os/runtime";
import { EventBus } from "../ledger";
import { JsonStringifyError, SqlError, UpstreamFailure } from "@agent-os/kernel/errors";
import { commitLedgerTransaction } from "../ledger/commit";
import { loadAdmissionRows } from "./payload";
import type { BackendProtocolEventIdentity } from "@agent-os/backend-protocol";

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

export const AdmissionLive = (
  ctx: DurableObjectState,
  ownerIdentity: BackendProtocolEventIdentity,
): Layer.Layer<Admission, never, EventBus | LlmTransport> =>
  Layer.scoped(
    Admission,
    Effect.gen(function* () {
      const sql = ctx.storage.sql;
      const bus = yield* EventBus;
      const llm = yield* LlmTransport;

      const attemptStructured = <O>(
        spec: AttemptSpec,
      ): Effect.Effect<AttemptResult<O>, SqlError | JsonStringifyError | UpstreamFailure> =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const key: AttemptKey = {
            routeFingerprint: routeFingerprint(spec.route),
            schemaFingerprint: spec.schemaSpec.fingerprint,
            strategy: spec.strategy,
            providerOutputAdapterVersion: llm.describeRoute(spec.route)
              .providerOutputAdapterVersion,
            transportAdapterVersion: llm.describeRoute(spec.route).transportAdapterVersion,
          };

          // Step 2: project lease.
          const rows = yield* loadAdmissionRows(sql, ownerIdentity, ownerIdentity.factOwnerRef);
          const { lease: preLease, latestBarrier } = projectLease(rows, key, now);

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

          const descriptor = llm.describeRoute(spec.route);
          const responseEither = yield* Effect.either(
            llm.call(
              structuredOutputRequest({
                route: spec.route,
                schemaSpec: spec.schemaSpec,
                stimulus: spec.stimulus,
                traceContext: spec.traceContext,
              }),
              { signal: spec.signal },
            ),
          );

          let outcome: Outcome;
          let decoded: DecodedOutput | undefined;

          if (responseEither._tag === "Left") {
            const classified = classifyStructuredCallFailure(responseEither.left);
            if (classified.kind === "fail_before_evidence") {
              return yield* Effect.fail(classified.failure);
            }
            outcome = classified.outcome;
          } else {
            const d = yield* decodeStructuredOutputFromItems<DecodedOutput>({
              items: responseEither.right.items,
              usage: responseEither.right.usage,
              schemaSpec: spec.schemaSpec,
            });
            if (d.ok) {
              decoded = d.decoded;
              outcome = { class: "Supported", tokensUsed: d.tokensUsed };
            } else {
              outcome = d.outcome;
            }
          }

          // Step 7: admission impact from pre-call inputs only.
          const admissionImpact = decideTier(preLease, outcome, spec.stimulus.kind, latestBarrier);

          // Step 8: commit admission evidence. Submit owns deliver/terminal.
          const evidencePayload = {
            key,
            stimulusKind: spec.stimulus.kind,
            outcome,
            admissionImpact,
            adapterId: descriptor.providerOutputAdapterId,
            ...(spec.traceContext === undefined ? {} : { traceContext: spec.traceContext }),
          };

          yield* commitLedgerTransaction(
            ctx,
            bus,
            { factOwnerRef: ownerIdentity.factOwnerRef },
            (tx) => {
              tx.append({
                ts: now,
                kind: "llm.structured.evidence",
                scopeRef: ownerIdentity.scopeRef,
                effectAuthorityRef: ownerIdentity.effectAuthorityRef,
                payload: evidencePayload,
              });
            },
          );

          // Post-projection (read-only, for the return value's lease shape).
          const postRows = yield* loadAdmissionRows(sql, ownerIdentity, ownerIdentity.factOwnerRef);
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

          const result = yield* commitLedgerTransaction(
            ctx,
            bus,
            { factOwnerRef: ownerIdentity.factOwnerRef },
            (tx) => {
              tx.append({
                ts: now,
                kind: "llm.structured.invalidate",
                scopeRef: ownerIdentity.scopeRef,
                effectAuthorityRef: ownerIdentity.effectAuthorityRef,
                payload,
              });
            },
          );
          const event = result.events[0];
          if (event === undefined) {
            return yield* Effect.fail(
              new SqlError({ cause: { reason: "invalidate_commit_returned_no_event" } }),
            );
          }

          return { barrierId: event.id };
        });

      return { attemptStructured, invalidate };
    }),
  );
