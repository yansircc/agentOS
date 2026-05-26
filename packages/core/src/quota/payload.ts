import { Schema } from "effect";

export const ConsumedPayloadSchema = Schema.Struct({
  key: Schema.String,
  amount: Schema.Number.pipe(Schema.finite()),
  toolName: Schema.String,
});

export const decodeConsumedPayloadSync = Schema.decodeUnknownSync(
  ConsumedPayloadSchema,
);
