/**
 * Owned payload schemas + IO helper for reading admission rows from the
 * events table.
 *
 * Admission is the SOLE writer of `llm.structured.evidence` and
 * `llm.structured.invalidate` (contract §2 + contract §3.1). Any payload
 * shape mismatch read back here is infra corruption — same failure path
 * as quota's malformed-payload defense (quota-service.ts:97).
 * `Schema.decodeUnknownSync` throws → `Effect.try` wraps as `SqlError`;
 * no silent `undefined.x` defect leaks through `projectLease`.
 */

import { Effect, Schema } from "effect";
import { SqlError } from "@agent-os/kernel/errors";
import { sqlText } from "../storage/sql-row";
import type {
  AdmissionRow,
  AttemptKey,
  LedgerTruthIdentity,
  Outcome,
} from "@agent-os/runtime-protocol";
import {
  LLM_STRUCTURED_EVIDENCE_EVENT,
  LLM_STRUCTURED_INVALIDATE_EVENT,
} from "@agent-os/runtime-protocol";
import { eventIdentity, eventIdentityColumns } from "../ledger/identity";
import type { FactOwnerRef } from "@agent-os/kernel/effect-claim";

const AttemptKeySchema = Schema.Struct({
  routeFingerprint: Schema.String,
  schemaFingerprint: Schema.String,
  strategy: Schema.Literal("forced-tool-call"),
  providerOutputAdapterVersion: Schema.String,
  transportAdapterVersion: Schema.String,
});

const OutcomeSchema = Schema.Union([
  Schema.Struct({ class: Schema.Literal("Supported"), tokensUsed: Schema.Number }),
  Schema.Struct({
    class: Schema.Literal("ProviderRejected"),
    status: Schema.Number,
    body: Schema.String,
  }),
  Schema.Struct({ class: Schema.Literal("SchemaUnsupported"), reason: Schema.String }),
  Schema.Struct({ class: Schema.Literal("BehaviorFailed"), sampleDigest: Schema.String }),
  Schema.Struct({ class: Schema.Literal("AuthError"), status: Schema.Number }),
  Schema.Struct({
    class: Schema.Literal("RateLimited"),
    retryAfterMs: Schema.optional(Schema.Number),
  }),
  Schema.Struct({ class: Schema.Literal("TransientError"), cause: Schema.String }),
  Schema.Struct({ class: Schema.Literal("ConfigError"), reason: Schema.String }),
]);

export const EvidencePayloadSchema = Schema.Struct({
  key: AttemptKeySchema,
  stimulusKind: Schema.Literals(["probe", "live"]),
  outcome: OutcomeSchema,
  admissionImpact: Schema.Literals(["lease-bearing", "reinforcement"]),
  // adapterId is metadata; ignored by projection. Optional for forward-compat.
  adapterId: Schema.optional(Schema.String),
});
const decodeEvidencePayloadSync = Schema.decodeUnknownSync(EvidencePayloadSchema);

export const InvalidatePayloadSchema = Schema.Struct({
  // Barriers carry a Partial<AttemptKey> (wildcarded keys allowed per §8.1),
  // so every field of the inner key is optional.
  key: Schema.Struct({
    routeFingerprint: Schema.optional(Schema.String),
    schemaFingerprint: Schema.optional(Schema.String),
    strategy: Schema.optional(Schema.Literal("forced-tool-call")),
    providerOutputAdapterVersion: Schema.optional(Schema.String),
    transportAdapterVersion: Schema.optional(Schema.String),
  }),
  reason: Schema.String,
  by: Schema.String,
});
const decodeInvalidatePayloadSync = Schema.decodeUnknownSync(InvalidatePayloadSchema);

export const loadAdmissionRows = (
  sql: SqlStorage,
  identity: LedgerTruthIdentity,
  factOwnerRef: FactOwnerRef,
): Effect.Effect<ReadonlyArray<AdmissionRow>, SqlError> =>
  Effect.try({
    try: () => {
      const columns = eventIdentityColumns(eventIdentity(identity, factOwnerRef));
      const raw = sql
        .exec(
          `SELECT id, ts, kind, payload FROM events WHERE event_identity_key = ? AND (kind = '${LLM_STRUCTURED_EVIDENCE_EVENT}' OR kind = '${LLM_STRUCTURED_INVALIDATE_EVENT}') ORDER BY id`,
          columns.event_identity_key,
        )
        .toArray();
      const out: AdmissionRow[] = [];
      for (const r of raw) {
        const id = Number(r.id);
        const ts = Number(r.ts);
        const kind = sqlText(r.kind, "events.kind");
        const parsed = JSON.parse(sqlText(r.payload, "events.payload")) as unknown;
        if (kind === LLM_STRUCTURED_EVIDENCE_EVENT) {
          const ev = decodeEvidencePayloadSync(parsed);
          out.push({
            id,
            ts,
            kind: LLM_STRUCTURED_EVIDENCE_EVENT,
            key: ev.key as AttemptKey,
            stimulusKind: ev.stimulusKind,
            outcome: ev.outcome as Outcome,
            admissionImpact: ev.admissionImpact,
          });
        } else if (kind === LLM_STRUCTURED_INVALIDATE_EVENT) {
          const inv = decodeInvalidatePayloadSync(parsed);
          out.push({
            id,
            ts,
            kind: LLM_STRUCTURED_INVALIDATE_EVENT,
            key: inv.key,
          });
        }
      }
      return out;
    },
    catch: (cause) => new SqlError({ cause }),
  });
