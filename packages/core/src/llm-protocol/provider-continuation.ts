import { Data, Effect, Schema } from "effect";
import type { Live } from "../value-brands";

export type LlmProviderContinuationJson =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<LlmProviderContinuationJson>
  | Readonly<{ [key: string]: LlmProviderContinuationJson }>;

export interface LlmProviderContinuationTurn {
  readonly id: number;
  readonly index: number;
}

export interface LlmProviderContinuationBinding {
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly routeFingerprint: string;
  readonly modelFingerprint: string;
  readonly truthIdentityFingerprint: string;
  readonly sourceTurn: LlmProviderContinuationTurn;
  readonly successorTurn: LlmProviderContinuationTurn;
}

export type LlmProviderContinuation =
  | {
      readonly kind: "live";
      readonly binding: LlmProviderContinuationBinding;
      readonly payload: Live<LlmProviderContinuationJson>;
    }
  | {
      readonly kind: "sealed";
      readonly binding: LlmProviderContinuationBinding;
      readonly ref: string;
    };

export interface LlmProviderContinuationMarker {
  readonly required: true;
  readonly binding: LlmProviderContinuationBinding;
  readonly sealedRef?: string;
}

export interface LlmProviderContinuationCallContext {
  readonly truthIdentityFingerprint: string;
  readonly turn: LlmProviderContinuationTurn;
}

export class LlmProviderContinuationFailure extends Data.TaggedError(
  "agent_os.llm_provider_continuation_failure",
)<{
  readonly reason:
    | "store_unavailable"
    | "continuation_missing"
    | "continuation_malformed"
    | "adapter_mismatch"
    | "route_mismatch"
    | "model_mismatch"
    | "truth_identity_mismatch"
    | "source_turn_mismatch"
    | "successor_turn_mismatch"
    | "sealed_ref_missing"
    | "store_failed";
}> {}

export interface LlmProviderContinuationStore {
  readonly available: boolean;
  readonly seal: (input: {
    readonly binding: LlmProviderContinuationBinding;
    readonly payload: Live<LlmProviderContinuationJson>;
  }) => Effect.Effect<string, LlmProviderContinuationFailure>;
  readonly open: (input: {
    readonly binding: LlmProviderContinuationBinding;
    readonly ref: string;
  }) => Effect.Effect<Live<LlmProviderContinuationJson>, LlmProviderContinuationFailure>;
}

const storeUnavailable = () =>
  Effect.fail(new LlmProviderContinuationFailure({ reason: "store_unavailable" }));

export const LlmProviderContinuationStoreNone: LlmProviderContinuationStore = {
  available: false,
  seal: storeUnavailable,
  open: storeUnavailable,
};

export const LlmProviderContinuationBindingSchema: Schema.Decoder<LlmProviderContinuationBinding> =
  Schema.Struct({
    adapterId: Schema.NonEmptyString,
    adapterVersion: Schema.NonEmptyString,
    routeFingerprint: Schema.NonEmptyString,
    modelFingerprint: Schema.NonEmptyString,
    truthIdentityFingerprint: Schema.NonEmptyString,
    sourceTurn: Schema.Struct({ id: Schema.Int, index: Schema.Int }),
    successorTurn: Schema.Struct({ id: Schema.Int, index: Schema.Int }),
  });

export const LlmProviderContinuationMarkerSchema: Schema.Decoder<LlmProviderContinuationMarker> =
  Schema.Struct({
    required: Schema.Literal(true),
    binding: LlmProviderContinuationBindingSchema,
    sealedRef: Schema.optional(Schema.NonEmptyString),
  });

export const markerFromProviderContinuation = (
  continuation: LlmProviderContinuation,
): LlmProviderContinuationMarker => ({
  required: true,
  binding: continuation.binding,
  ...(continuation.kind === "sealed" ? { sealedRef: continuation.ref } : {}),
});

const sameTurn = (left: LlmProviderContinuationTurn, right: LlmProviderContinuationTurn): boolean =>
  left.id === right.id && left.index === right.index;

export const validateProviderContinuationBinding = (
  actual: LlmProviderContinuationBinding,
  expected: LlmProviderContinuationBinding,
): LlmProviderContinuationFailure | null => {
  if (
    actual.adapterId !== expected.adapterId ||
    actual.adapterVersion !== expected.adapterVersion
  ) {
    return new LlmProviderContinuationFailure({ reason: "adapter_mismatch" });
  }
  if (actual.routeFingerprint !== expected.routeFingerprint) {
    return new LlmProviderContinuationFailure({ reason: "route_mismatch" });
  }
  if (actual.modelFingerprint !== expected.modelFingerprint) {
    return new LlmProviderContinuationFailure({ reason: "model_mismatch" });
  }
  if (actual.truthIdentityFingerprint !== expected.truthIdentityFingerprint) {
    return new LlmProviderContinuationFailure({ reason: "truth_identity_mismatch" });
  }
  if (!sameTurn(actual.sourceTurn, expected.sourceTurn)) {
    return new LlmProviderContinuationFailure({ reason: "source_turn_mismatch" });
  }
  if (!sameTurn(actual.successorTurn, expected.successorTurn)) {
    return new LlmProviderContinuationFailure({ reason: "successor_turn_mismatch" });
  }
  return null;
};
