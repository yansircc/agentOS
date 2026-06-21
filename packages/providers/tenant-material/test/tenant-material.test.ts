import { describe, expect, it } from "vite-plus/test"; // eff-ignore EFF200 reason="repo tests use vite-plus; this test only adapts the new Effect constructor"
import { Effect, Exit } from "effect";
import { credentialMaterialRef, endpointMaterialRef } from "@agent-os/core/material-ref";
import type { RefResolver } from "@agent-os/core/ref-resolver";

import {
  createTenantCredentialResolver,
  summarizeTenantCredentialRecord,
  tenantCredentialResolutionRejection,
  type EncryptedTenantCredentialRecord,
  type TenantCredentialLookup,
  type TenantCredentialMaterial,
  type TenantCredentialResolverOptions,
} from "../src";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const bytes = (value: string): Uint8Array => encoder.encode(value);

const baseRecord = (overrides: Partial<EncryptedTenantCredentialRecord> = {}) =>
  ({
    tenantId: "tenant-a",
    ref: "credential-slot-a",
    provider: "openai-chat-compatible",
    purpose: "llm_transport",
    encryptedBytes: bytes("ciphertext"),
    ...overrides,
  }) satisfies EncryptedTenantCredentialRecord;

const makeResolver = (options: TenantCredentialResolverOptions): RefResolver =>
  Effect.runSync(createTenantCredentialResolver(options)); // eff-ignore EFF400 reason="test helper unwraps constructor Effect for synchronous resolver assertions"

const makeResolverExit = (options: TenantCredentialResolverOptions) =>
  Effect.runSyncExit(createTenantCredentialResolver(options)); // eff-ignore EFF400 reason="test unwraps constructor failure"

describe("@agent-os/tenant-material", () => {
  it("returns a core RefResolver that decrypts exact tenant credential material only at material()", () => {
    const record = baseRecord({ encryptedBytes: bytes("ciphertext:exact") });
    const lookups: Array<TenantCredentialLookup> = [];
    const decryptInputs: Array<{
      readonly encrypted: string;
      readonly context: TenantCredentialLookup;
    }> = [];
    const resolver = makeResolver({
      tenantId: "tenant-a",
      store: {
        get: (lookup) => {
          lookups.push(lookup);
          return record;
        },
      },
      decrypt: ({ encryptedBytes, context }) => {
        decryptInputs.push({
          encrypted: decoder.decode(encryptedBytes),
          context,
        });
        return `resolved:${context.tenantId}:${context.ref}:${context.provider}:${context.purpose}`;
      },
    });
    const ref = credentialMaterialRef("credential-slot-a", {
      provider: "openai-chat-compatible",
      purpose: "llm_transport",
    });

    expect(resolver.material(ref)).toBe(
      "resolved:tenant-a:credential-slot-a:openai-chat-compatible:llm_transport",
    );
    expect(resolver.material(ref)).toBe(
      "resolved:tenant-a:credential-slot-a:openai-chat-compatible:llm_transport",
    );
    expect(lookups).toEqual([
      {
        tenantId: "tenant-a",
        ref: "credential-slot-a",
        provider: "openai-chat-compatible",
        purpose: "llm_transport",
      },
      {
        tenantId: "tenant-a",
        ref: "credential-slot-a",
        provider: "openai-chat-compatible",
        purpose: "llm_transport",
      },
    ]);
    expect(decryptInputs).toEqual([
      {
        encrypted: "ciphertext:exact",
        context: {
          tenantId: "tenant-a",
          ref: "credential-slot-a",
          provider: "openai-chat-compatible",
          purpose: "llm_transport",
        },
      },
      {
        encrypted: "ciphertext:exact",
        context: {
          tenantId: "tenant-a",
          ref: "credential-slot-a",
          provider: "openai-chat-compatible",
          purpose: "llm_transport",
        },
      },
    ]);
  });

  it("fails closed before decrypting when kind, provider, purpose, tenant, or record axes do not match", () => {
    const ref = credentialMaterialRef("credential-slot-a", {
      provider: "openai-chat-compatible",
      purpose: "llm_transport",
    });
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly ref: Parameters<RefResolver["material"]>[0];
      readonly record: EncryptedTenantCredentialRecord | null;
      readonly expectedLookups: number;
    }> = [
      {
        name: "non credential",
        ref: endpointMaterialRef("endpoint-a", { protocol: "openai-chat-compatible" }),
        record: baseRecord(),
        expectedLookups: 0,
      },
      {
        name: "missing provider",
        ref: credentialMaterialRef("credential-slot-a", { purpose: "llm_transport" }),
        record: baseRecord(),
        expectedLookups: 0,
      },
      {
        name: "missing purpose",
        ref: credentialMaterialRef("credential-slot-a", { provider: "openai-chat-compatible" }),
        record: baseRecord(),
        expectedLookups: 0,
      },
      {
        name: "missing record",
        ref,
        record: null,
        expectedLookups: 1,
      },
      {
        name: "tenant mismatch",
        ref,
        record: baseRecord({ tenantId: "tenant-b" }),
        expectedLookups: 1,
      },
      {
        name: "ref mismatch",
        ref,
        record: baseRecord({ ref: "credential-slot-b" }),
        expectedLookups: 1,
      },
      {
        name: "provider mismatch",
        ref,
        record: baseRecord({ provider: "gemini-generate-content" }),
        expectedLookups: 1,
      },
      {
        name: "purpose mismatch",
        ref,
        record: baseRecord({ purpose: "image_transport" }),
        expectedLookups: 1,
      },
      {
        name: "invalid encrypted bytes",
        ref,
        record: { ...baseRecord(), encryptedBytes: "plaintext" as unknown as Uint8Array },
        expectedLookups: 1,
      },
    ];

    for (const testCase of cases) {
      const lookups: Array<TenantCredentialLookup> = [];
      let decryptCount = 0;
      const resolver = makeResolver({
        tenantId: "tenant-a",
        store: {
          get: (lookup) => {
            lookups.push(lookup);
            return testCase.record;
          },
        },
        decrypt: () => {
          decryptCount += 1;
          return "must-not-resolve";
        },
      });

      expect(resolver.material(testCase.ref), testCase.name).toBeNull();
      expect(lookups, testCase.name).toHaveLength(testCase.expectedLookups);
      expect(decryptCount, testCase.name).toBe(0);
    }
  });

  it("fast fails when decrypt throws and returns null for non-material output", () => {
    const ref = credentialMaterialRef("credential-slot-a", {
      provider: "openai-chat-compatible",
      purpose: "llm_transport",
    });
    const throwing = makeResolver({
      tenantId: "tenant-a",
      store: { get: () => baseRecord() },
      decrypt: () => {
        throw new Error("decrypt implementation failed");
      },
    });
    const invalid = makeResolver({
      tenantId: "tenant-a",
      store: { get: () => baseRecord() },
      decrypt: () => ({ secret: "not resolver material" }) as unknown as TenantCredentialMaterial,
    });

    expect(() => throwing.material(ref)).toThrow("decrypt implementation failed");
    expect(invalid.material(ref)).toBeNull();
  });

  it("accepts decrypted byte material without serializing it into summaries", () => {
    const secretBytes = bytes("byte-secret-material");
    const secretBuffer = new ArrayBuffer(secretBytes.byteLength);
    new Uint8Array(secretBuffer).set(secretBytes);
    const resolver = makeResolver({
      tenantId: "tenant-a",
      store: { get: () => baseRecord() },
      decrypt: () => secretBuffer,
    });
    const ref = credentialMaterialRef("credential-slot-a", {
      provider: "openai-chat-compatible",
      purpose: "llm_transport",
    });
    const material = resolver.material(ref);

    expect(material).toBeInstanceOf(Uint8Array);
    expect(decoder.decode(material as Uint8Array)).toBe("byte-secret-material");
    expect(JSON.stringify(summarizeTenantCredentialRecord(baseRecord()))).not.toContain(
      "byte-secret-material",
    );
  });

  it("rejects ambient tenant configuration at construction", () => {
    const exit = makeResolverExit({
      tenantId: "",
      store: { get: () => null },
      decrypt: () => "unused",
    });

    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("keeps generated public artifacts symbolic under adversarial plaintext scans", () => {
    const plaintexts = [
      "sk-live-secret-000000",
      "Bearer resolved-secret-token",
      '{"apiKey":"resolved-json-secret"}',
      "</script><script>alert('resolved-secret')</script>",
      "line1\\nresolved-secret=line2\\nline3",
      ...deterministicPlaintexts(24),
    ];

    for (const plaintext of plaintexts) {
      const record = baseRecord({
        encryptedBytes: bytes(`ciphertext prefix ${plaintext} ciphertext suffix`),
      });
      const ref = credentialMaterialRef("credential-slot-a", {
        provider: "openai-chat-compatible",
        purpose: "llm_transport",
      });
      const resolver = makeResolver({
        tenantId: "tenant-a",
        store: { get: () => record },
        decrypt: () => plaintext,
      });
      const material = resolver.material(ref);
      expect(material).toBe(plaintext);

      const publicArtifacts = [
        ref,
        tenantCredentialResolutionRejection({
          tenantId: "tenant-a",
          ref,
          reason: "decrypt_failed",
        }),
        summarizeTenantCredentialRecord(record),
      ];

      for (const artifact of publicArtifacts) {
        expect(JSON.stringify(artifact)).not.toContain(plaintext);
      }
      expect(JSON.stringify(summarizeTenantCredentialRecord(record))).not.toContain(
        "encryptedBytes",
      );
    }
  });
});

const deterministicPlaintexts = (count: number): ReadonlyArray<string> => {
  let state = 0x1a2b3c4d;
  const out: Array<string> = [];
  for (let i = 0; i < count; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out.push(`resolved-secret-${i.toString(16)}-${state.toString(36)}-"'<>&%${i}`);
  }
  return out;
};
