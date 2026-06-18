import { Data, Effect } from "effect";

import type { MaterialRef } from "../material-ref";
import type { Live, Recorded, RecordedPayload, RecordedPayloadValue } from "../value-brands";
import { captureLive, openLive } from "./live-edge";

export const AEAD_SEALED_KIND = "aead.sealed";
export const AEAD_SEALED_CODEC = "agentos.aead";
export const AEAD_SEALED_VERSION = 1;
export const AEAD_SEALED_ALGORITHM = "AES-GCM";

export type AeadSealedFailureReason =
  | "crypto_unavailable"
  | "invalid_aad"
  | "invalid_key"
  | "unsupported_kind"
  | "unsupported_codec"
  | "unsupported_version"
  | "unsupported_algorithm"
  | "key_ref_mismatch"
  | "aad_mismatch"
  | "malformed_nonce"
  | "malformed_ciphertext"
  | "authentication_failed";

export class AeadSealedCodecFailure extends Data.TaggedError("agent_os.aead_sealed_codec_failure")<{
  readonly reason: AeadSealedFailureReason;
}> {}

export interface SealedEnvelope {
  readonly kind: typeof AEAD_SEALED_KIND;
  readonly codec: typeof AEAD_SEALED_CODEC;
  readonly version: typeof AEAD_SEALED_VERSION;
  readonly algorithm: typeof AEAD_SEALED_ALGORITHM;
  readonly keyRef: MaterialRef;
  readonly nonce: string;
  readonly aad: RecordedPayload;
  readonly ciphertext: string;
}

export type RecordedSealedEnvelope = Recorded<SealedEnvelope>;
export type AeadKeyMaterial = CryptoKey | Uint8Array;
export type AeadPlaintext = string | Uint8Array;

export interface SealAeadInput {
  readonly plaintext: Live<AeadPlaintext>;
  readonly key: Live<AeadKeyMaterial>;
  readonly keyRef: MaterialRef;
  readonly aad: RecordedPayload;
  readonly crypto?: Pick<Crypto, "getRandomValues" | "subtle">;
}

export interface OpenAeadInput {
  readonly sealed: RecordedSealedEnvelope;
  readonly key: Live<AeadKeyMaterial>;
  readonly keyRef: MaterialRef;
  readonly expectedAad: RecordedPayload;
  readonly crypto?: Pick<Crypto, "subtle">;
}

type CanonicalJson =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: "invalid_aad" };

type DecodedBytes =
  | { readonly ok: true; readonly value: Uint8Array }
  | { readonly ok: false; readonly reason: "malformed_nonce" | "malformed_ciphertext" };

const textEncoder = new TextEncoder();
const base64UrlGrammar = /^[A-Za-z0-9_-]*$/u;

const fail = (reason: AeadSealedFailureReason) => new AeadSealedCodecFailure({ reason });

const bytesOf = (value: AeadPlaintext): Uint8Array =>
  typeof value === "string" ? textEncoder.encode(value) : Uint8Array.from(value);

const ownedBytes = (value: Uint8Array): Uint8Array => Uint8Array.from(value);

const arrayBufferOf = (bytes: Uint8Array): ArrayBuffer => {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
};

const isCryptoKey = (value: unknown): value is CryptoKey =>
  typeof CryptoKey !== "undefined" && value instanceof CryptoKey;

const cryptoOrFail = (
  override: Pick<Crypto, "getRandomValues" | "subtle"> | undefined,
): Effect.Effect<Pick<Crypto, "getRandomValues" | "subtle">, AeadSealedCodecFailure> => {
  if (override !== undefined) return Effect.succeed(override);
  if (typeof globalThis.crypto === "undefined") return Effect.fail(fail("crypto_unavailable"));
  return Effect.succeed(globalThis.crypto);
};

const subtleCryptoOrFail = (
  override: Pick<Crypto, "subtle"> | undefined,
): Effect.Effect<Pick<Crypto, "subtle">, AeadSealedCodecFailure> => {
  if (override !== undefined) return Effect.succeed(override);
  if (typeof globalThis.crypto === "undefined") return Effect.fail(fail("crypto_unavailable"));
  return Effect.succeed(globalThis.crypto);
};

const importAesKey = (
  crypto: Pick<Crypto, "subtle">,
  key: AeadKeyMaterial,
  usage: KeyUsage,
): Effect.Effect<CryptoKey, AeadSealedCodecFailure> => {
  if (isCryptoKey(key)) return Effect.succeed(key);
  const raw = ownedBytes(key);
  return Effect.tryPromise({
    try: () =>
      crypto.subtle.importKey("raw", arrayBufferOf(raw), AEAD_SEALED_ALGORITHM, false, [usage]),
    catch: () => fail("invalid_key"),
  });
};

const canonicalPayloadValue = (value: unknown): CanonicalJson => {
  if (value === null) return { ok: true, value: "null" };
  if (typeof value === "boolean") return { ok: true, value: value ? "true" : "false" };
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? { ok: true, value: JSON.stringify(value) }
      : { ok: false, reason: "invalid_aad" };
  }
  if (typeof value === "string") return { ok: true, value: JSON.stringify(value) };
  if (Array.isArray(value)) {
    const encoded = value.map(canonicalPayloadValue);
    const invalid = encoded.find((item) => !item.ok);
    if (invalid !== undefined) return { ok: false, reason: "invalid_aad" };
    return {
      ok: true,
      value: `[${encoded.map((item) => (item.ok ? item.value : "")).join(",")}]`,
    };
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Readonly<Record<string, unknown>>;
    const fields: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const encoded = canonicalPayloadValue(record[key]);
      if (!encoded.ok) return encoded;
      fields.push(`${JSON.stringify(key)}:${encoded.value}`);
    }
    return { ok: true, value: `{${fields.join(",")}}` };
  }
  return { ok: false, reason: "invalid_aad" };
};

const clonePayloadValue = (value: RecordedPayloadValue): RecordedPayloadValue => {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(clonePayloadValue);
  const clone: Record<string, RecordedPayloadValue> = {};
  const record = value as { readonly [key: string]: RecordedPayloadValue };
  for (const key of Object.keys(value).sort()) {
    clone[key] = clonePayloadValue(record[key]);
  }
  return clone;
};

const cloneRecordedPayload = (payload: RecordedPayload): RecordedPayload =>
  clonePayloadValue(payload) as RecordedPayload;

const aadBytes = (payload: RecordedPayload): Effect.Effect<Uint8Array, AeadSealedCodecFailure> => {
  const canonical = canonicalPayloadValue(payload);
  return canonical.ok
    ? Effect.succeed(textEncoder.encode(canonical.value))
    : Effect.fail(fail(canonical.reason));
};

const sameRecordedPayload = (left: RecordedPayload, right: RecordedPayload): boolean => {
  const leftCanonical = canonicalPayloadValue(left);
  const rightCanonical = canonicalPayloadValue(right);
  return leftCanonical.ok && rightCanonical.ok && leftCanonical.value === rightCanonical.value;
};

const sameMaterialRef = (left: MaterialRef, right: MaterialRef): boolean => {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "credential":
      return (
        right.kind === "credential" &&
        left.ref === right.ref &&
        left.provider === right.provider &&
        left.purpose === right.purpose
      );
    case "endpoint":
      return (
        right.kind === "endpoint" && left.ref === right.ref && left.protocol === right.protocol
      );
    case "binding":
      return (
        right.kind === "binding" &&
        left.ref === right.ref &&
        left.provider === right.provider &&
        left.bindingKind === right.bindingKind
      );
    case "external_resource":
      return (
        right.kind === "external_resource" &&
        left.ref === right.ref &&
        left.provider === right.provider &&
        left.resourceKind === right.resourceKind
      );
  }
};

const encodeBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

const decodeBase64Url = (
  value: string,
  reason: "malformed_nonce" | "malformed_ciphertext",
): DecodedBytes => {
  if (!base64UrlGrammar.test(value) || value.length % 4 === 1) {
    return { ok: false, reason };
  }
  const padding = value.length % 4 === 0 ? "" : "=".repeat(4 - (value.length % 4));
  const binary = atob(`${value}${padding}`.replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return { ok: true, value: bytes };
};

const validateEnvelope = (
  envelope: SealedEnvelope,
  expectedKeyRef: MaterialRef,
  expectedAad: RecordedPayload,
): Effect.Effect<
  { readonly nonce: Uint8Array; readonly ciphertext: Uint8Array },
  AeadSealedCodecFailure
> => {
  if (envelope.kind !== AEAD_SEALED_KIND) return Effect.fail(fail("unsupported_kind"));
  if (envelope.codec !== AEAD_SEALED_CODEC) return Effect.fail(fail("unsupported_codec"));
  if (envelope.version !== AEAD_SEALED_VERSION) return Effect.fail(fail("unsupported_version"));
  if (envelope.algorithm !== AEAD_SEALED_ALGORITHM) {
    return Effect.fail(fail("unsupported_algorithm"));
  }
  if (!sameMaterialRef(envelope.keyRef, expectedKeyRef))
    return Effect.fail(fail("key_ref_mismatch"));
  if (!sameRecordedPayload(envelope.aad, expectedAad)) return Effect.fail(fail("aad_mismatch"));

  const nonce = decodeBase64Url(envelope.nonce, "malformed_nonce");
  if (!nonce.ok || nonce.value.byteLength !== 12) return Effect.fail(fail("malformed_nonce"));

  const ciphertext = decodeBase64Url(envelope.ciphertext, "malformed_ciphertext");
  if (!ciphertext.ok || ciphertext.value.byteLength < 16) {
    return Effect.fail(fail("malformed_ciphertext"));
  }

  return Effect.succeed({ nonce: nonce.value, ciphertext: ciphertext.value });
};

export const sealAead = (
  input: SealAeadInput,
): Effect.Effect<RecordedSealedEnvelope, AeadSealedCodecFailure> =>
  Effect.gen(function* () {
    const crypto = yield* cryptoOrFail(input.crypto);
    const nonce = new Uint8Array(12);
    crypto.getRandomValues(nonce);
    const key = yield* importAesKey(crypto, openLive(input.key), "encrypt");
    const additionalData = yield* aadBytes(input.aad);
    const plaintext = bytesOf(openLive(input.plaintext));
    const encrypted = yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.encrypt(
          {
            name: AEAD_SEALED_ALGORITHM,
            iv: arrayBufferOf(nonce),
            additionalData: arrayBufferOf(additionalData),
          },
          key,
          arrayBufferOf(plaintext),
        ),
      catch: () => fail("authentication_failed"),
    });
    const envelope: SealedEnvelope = {
      kind: AEAD_SEALED_KIND,
      codec: AEAD_SEALED_CODEC,
      version: AEAD_SEALED_VERSION,
      algorithm: AEAD_SEALED_ALGORITHM,
      keyRef: input.keyRef,
      nonce: encodeBase64Url(nonce),
      aad: cloneRecordedPayload(input.aad),
      ciphertext: encodeBase64Url(new Uint8Array(encrypted)),
    };
    return { value: envelope } as RecordedSealedEnvelope;
  });

export const openAead = (
  input: OpenAeadInput,
): Effect.Effect<Live<Uint8Array>, AeadSealedCodecFailure> =>
  Effect.gen(function* () {
    const crypto = yield* subtleCryptoOrFail(input.crypto);
    const envelope = input.sealed.value;
    const decoded = yield* validateEnvelope(envelope, input.keyRef, input.expectedAad);
    const additionalData = yield* aadBytes(input.expectedAad);
    const key = yield* importAesKey(crypto, openLive(input.key), "decrypt");
    const plaintext = yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.decrypt(
          {
            name: AEAD_SEALED_ALGORITHM,
            iv: arrayBufferOf(decoded.nonce),
            additionalData: arrayBufferOf(additionalData),
          },
          key,
          arrayBufferOf(decoded.ciphertext),
        ),
      catch: () => fail("authentication_failed"),
    });
    return captureLive(new Uint8Array(plaintext));
  });
