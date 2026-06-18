import { Cause, Effect, Exit, Option } from "effect";
import { describe, expect, it } from "@effect/vitest";

import { credentialMaterialRef } from "../src/material-ref";
import {
  AEAD_SEALED_ALGORITHM,
  AEAD_SEALED_CODEC,
  AEAD_SEALED_KIND,
  AEAD_SEALED_VERSION,
  AeadSealedCodecFailure,
  openAead,
  sealAead,
  type AeadSealedFailureReason,
  type RecordedSealedEnvelope,
} from "../src/internal/aead-sealed";
import { captureLive, openLive } from "../src/internal/live-edge";
import type { MaterialRef } from "../src/material-ref";
import type { RecordedPayload } from "../src/value-brands";
import { recordedPayload } from "../src/value-brands";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const bytes = (value: string): Uint8Array => encoder.encode(value);

const keyRef = credentialMaterialRef("tenant-a/aead-key", {
  provider: "local-test",
  purpose: "sealed_state",
});

const keyBytes = (value: string): Uint8Array => bytes(value);

const expectAeadFailure = (
  exit: Exit.Exit<unknown, AeadSealedCodecFailure>,
  reason: AeadSealedFailureReason,
): void => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    const failure = Cause.findErrorOption(exit.cause);
    expect(Option.isSome(failure)).toBe(true);
    if (Option.isSome(failure)) {
      expect(failure.value).toBeInstanceOf(AeadSealedCodecFailure);
      expect(failure.value.reason).toBe(reason);
    }
  }
};

const sealFixture = (
  overrides: {
    readonly plaintext?: string;
    readonly key?: Uint8Array;
    readonly ref?: MaterialRef;
    readonly aad?: RecordedPayload;
  } = {},
) =>
  sealAead({
    plaintext: captureLive(overrides.plaintext ?? "secret durable state"),
    key: captureLive(overrides.key ?? keyBytes("0123456789abcdef0123456789abcdef")),
    keyRef: overrides.ref ?? keyRef,
    aad: overrides.aad ?? recordedPayload({ scope: "run-1", slot: "private-state" }),
  });

describe("Recorded<SealedEnvelope> AEAD codec", () => {
  it.effect(
    "seals live plaintext into recorded metadata and opens only with matching key ref and AAD",
    () =>
      Effect.gen(function* () {
        const aad = recordedPayload({ scope: "run-1", slot: "private-state" });
        const sealed = yield* sealFixture({ aad });
        const opened = yield* openAead({
          sealed,
          key: captureLive(keyBytes("0123456789abcdef0123456789abcdef")),
          keyRef,
          expectedAad: aad,
        });

        expect(decoder.decode(openLive(opened))).toBe("secret durable state");
        expect(sealed.value).toMatchObject({
          kind: AEAD_SEALED_KIND,
          codec: AEAD_SEALED_CODEC,
          version: AEAD_SEALED_VERSION,
          algorithm: AEAD_SEALED_ALGORITHM,
          keyRef,
          aad,
        });
        expect(sealed.value.nonce).toMatch(/^[A-Za-z0-9_-]+$/u);
        expect(sealed.value.ciphertext).toMatch(/^[A-Za-z0-9_-]+$/u);
      }),
  );

  it.effect("fails closed for wrong key, wrong AAD, and wrong key ref", () =>
    Effect.gen(function* () {
      const aad = recordedPayload({ scope: "run-1", slot: "private-state" });
      const sealed = yield* sealFixture({ aad });
      const wrongKey = yield* Effect.exit(
        openAead({
          sealed,
          key: captureLive(keyBytes("abcdef0123456789abcdef0123456789")),
          keyRef,
          expectedAad: aad,
        }),
      );
      const wrongAad = yield* Effect.exit(
        openAead({
          sealed,
          key: captureLive(keyBytes("0123456789abcdef0123456789abcdef")),
          keyRef,
          expectedAad: recordedPayload({ scope: "run-2", slot: "private-state" }),
        }),
      );
      const wrongKeyRef = yield* Effect.exit(
        openAead({
          sealed,
          key: captureLive(keyBytes("0123456789abcdef0123456789abcdef")),
          keyRef: credentialMaterialRef("tenant-a/aead-key", {
            provider: "local-test",
            purpose: "other_sealed_state",
          }),
          expectedAad: aad,
        }),
      );

      expectAeadFailure(wrongKey, "authentication_failed");
      expectAeadFailure(wrongAad, "aad_mismatch");
      expectAeadFailure(wrongKeyRef, "key_ref_mismatch");
    }),
  );

  it.effect("rejects unsupported version and malformed byte encodings before decrypting", () =>
    Effect.gen(function* () {
      const aad = recordedPayload({ scope: "run-1", slot: "private-state" });
      const sealed = yield* sealFixture({ aad });
      const unsupportedVersion: RecordedSealedEnvelope = {
        value: { ...sealed.value, version: 2 as typeof AEAD_SEALED_VERSION },
      } as RecordedSealedEnvelope;
      const malformedNonce: RecordedSealedEnvelope = {
        value: { ...sealed.value, nonce: "not base64url!" },
      } as RecordedSealedEnvelope;
      const malformedCiphertext: RecordedSealedEnvelope = {
        value: { ...sealed.value, ciphertext: "abc" },
      } as RecordedSealedEnvelope;

      expectAeadFailure(
        yield* Effect.exit(
          openAead({
            sealed: unsupportedVersion,
            key: captureLive(keyBytes("0123456789abcdef0123456789abcdef")),
            keyRef,
            expectedAad: aad,
          }),
        ),
        "unsupported_version",
      );
      expectAeadFailure(
        yield* Effect.exit(
          openAead({
            sealed: malformedNonce,
            key: captureLive(keyBytes("0123456789abcdef0123456789abcdef")),
            keyRef,
            expectedAad: aad,
          }),
        ),
        "malformed_nonce",
      );
      expectAeadFailure(
        yield* Effect.exit(
          openAead({
            sealed: malformedCiphertext,
            key: captureLive(keyBytes("0123456789abcdef0123456789abcdef")),
            keyRef,
            expectedAad: aad,
          }),
        ),
        "malformed_ciphertext",
      );
    }),
  );

  it.effect("never records plaintext or key bytes in the encoded envelope", () =>
    Effect.gen(function* () {
      const plaintext = "plaintext-marker-never-recorded";
      const key = "abcdefghijklmnopabcdefghijklmnop";
      const sealed = yield* sealFixture({
        plaintext,
        key: keyBytes(key),
        aad: recordedPayload({ scope: "run-1", slot: "private-state" }),
      });
      const encodedEnvelope = JSON.stringify(sealed.value);

      expect(encodedEnvelope).not.toContain(plaintext);
      expect(encodedEnvelope).not.toContain(key);
      expect(encodedEnvelope).toContain("tenant-a/aead-key");
    }),
  );
});
