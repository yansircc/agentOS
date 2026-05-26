/**
 * Owned payload Schemas for `events.kind = resource.*` rows.
 *
 * Leaf module: imports nothing from sibling resources/ files.
 * `projection.ts` and the orchestrator consume `decode*PayloadSync`;
 * shape drift between writer and reader surfaces as a thrown decode
 * error wrapped in `SqlError`, same defense as admission/payload.ts.
 */

import { Schema } from "effect";

export const GrantPayloadSchema = Schema.Struct({
  key: Schema.String,
  amount: Schema.Number.pipe(Schema.finite()),
  ref: Schema.String,
});

export const ReservePayloadSchema = Schema.Struct({
  key: Schema.String,
  amount: Schema.Number.pipe(Schema.finite()),
  ref: Schema.String,
  idempotencyKey: Schema.String,
  reservationId: Schema.String,
});

export const ReserveRejectedPayloadSchema = Schema.Struct({
  key: Schema.String,
  amount: Schema.Number.pipe(Schema.finite()),
  ref: Schema.String,
  idempotencyKey: Schema.String,
  available: Schema.Number.pipe(Schema.finite()),
});

export const TerminalPayloadSchema = Schema.Struct({
  reservationId: Schema.String,
  ref: Schema.String,
});

export const decodeGrantPayloadSync = Schema.decodeUnknownSync(
  GrantPayloadSchema,
);
export const decodeReservePayloadSync = Schema.decodeUnknownSync(
  ReservePayloadSchema,
);
export const decodeReserveRejectedPayloadSync = Schema.decodeUnknownSync(
  ReserveRejectedPayloadSchema,
);
export const decodeTerminalPayloadSync = Schema.decodeUnknownSync(
  TerminalPayloadSchema,
);
