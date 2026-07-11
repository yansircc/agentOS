import { describe, expect, it } from "@effect/vitest";
import {
  createLedgerArchiveArtifact,
  createLedgerArchiveReceipt,
  decodeLedgerArchiveArtifact,
  validateLedgerArchiveChain,
} from "@agent-os/core/backend-protocol";

const identity = {
  scopeRef: { kind: "conversation" as const, scopeId: "archive" },
  effectAuthorityRef: { authorityClass: "effect", authorityId: "archive" },
};
const event = (id: number, payload: unknown = { b: 2, a: 1 }) => ({
  id,
  ts: id,
  kind: "archive.fact",
  ...identity,
  factOwnerRef: "@agent-os/runtime",
  payload,
});

describe("ledger archive protocol", () => {
  it("canonicalizes content and verifies exact readback", async () => {
    const left = await createLedgerArchiveArtifact({
      identity,
      previousSegmentSha256: null,
      events: [event(1, { b: 2, a: 1 })],
    });
    const right = await createLedgerArchiveArtifact({
      identity,
      previousSegmentSha256: null,
      events: [event(1, { a: 1, b: 2 })],
    });
    expect(left.sha256).toBe(right.sha256);
    await expect(
      createLedgerArchiveReceipt({
        artifact: left,
        archiveRef: "archive:one",
        readback: left.bytes,
      }),
    ).resolves.toMatchObject({ eventCount: 1, firstEventId: 1, lastEventId: 1 });
  });

  it("preserves every own JSON key through canonical archive roundtrip", async () => {
    const payload = JSON.parse(
      '{"nested":[{"__proto__":{"kept":true},"constructor":"value","prototype":null}]}',
    ) as Record<string, unknown>;
    const artifact = await createLedgerArchiveArtifact({
      identity,
      previousSegmentSha256: null,
      events: [event(1, payload)],
    });

    expect(new TextDecoder().decode(artifact.bytes)).toContain('"__proto__"');
    const decoded = await decodeLedgerArchiveArtifact(artifact.bytes, artifact.sha256);
    const decodedPayload = decoded.segment.events[0]!.payload as {
      readonly nested: ReadonlyArray<Record<string, unknown>>;
    };
    expect(decodedPayload).toEqual(payload);
    expect(Object.hasOwn(decodedPayload.nested[0]!, "__proto__")).toBe(true);
  });

  it("rejects object and array cycles with the same traversal", async () => {
    const cyclicObject: Record<string, unknown> = {};
    cyclicObject.self = cyclicObject;
    const cyclicArray: unknown[] = [];
    cyclicArray.push(cyclicArray);

    await expect(
      createLedgerArchiveArtifact({
        identity,
        previousSegmentSha256: null,
        events: [event(1, cyclicObject)],
      }),
    ).rejects.toMatchObject({ reason: "cyclic value" });
    await expect(
      createLedgerArchiveArtifact({
        identity,
        previousSegmentSha256: null,
        events: [event(1, cyclicArray)],
      }),
    ).rejects.toMatchObject({ reason: "cyclic value" });
  });

  it("rejects invalid UTF-8 and valid JSON bytes that are not byte-canonical", async () => {
    const artifact = await createLedgerArchiveArtifact({
      identity,
      previousSegmentSha256: null,
      events: [event(1)],
    });
    const invalidUtf8 = new Uint8Array(artifact.bytes);
    invalidUtf8[invalidUtf8.length - 2] = 0xff;
    await expect(decodeLedgerArchiveArtifact(invalidUtf8)).rejects.toMatchObject({
      reason: "archive bytes are not valid UTF-8",
    });

    const nonCanonical = new Uint8Array(artifact.bytes.length + 1);
    nonCanonical.set(artifact.bytes);
    nonCanonical[nonCanonical.length - 1] = 0x20;
    await expect(decodeLedgerArchiveArtifact(nonCanonical)).rejects.toMatchObject({
      reason: "archive bytes are not canonical",
    });
  });

  it("rejects empty, mixed-truth, duplicate, and corrupt segments", async () => {
    await expect(
      createLedgerArchiveArtifact({ identity, previousSegmentSha256: null, events: [] }),
    ).rejects.toBeTruthy();
    await expect(
      createLedgerArchiveArtifact({
        identity,
        previousSegmentSha256: null,
        events: [{ ...event(1), scopeRef: { kind: "conversation", scopeId: "other" } }],
      }),
    ).rejects.toBeTruthy();
    await expect(
      createLedgerArchiveArtifact({
        identity,
        previousSegmentSha256: null,
        events: [event(1), event(1)],
      }),
    ).rejects.toBeTruthy();
    const artifact = await createLedgerArchiveArtifact({
      identity,
      previousSegmentSha256: null,
      events: [event(1)],
    });
    const corrupt = new Uint8Array(artifact.bytes);
    corrupt[corrupt.length - 2] ^= 1;
    await expect(decodeLedgerArchiveArtifact(corrupt, artifact.sha256)).rejects.toBeTruthy();
  });

  it("rejects chain forks and overlap", async () => {
    const first = await createLedgerArchiveArtifact({
      identity,
      previousSegmentSha256: null,
      events: [event(1)],
    });
    const second = await createLedgerArchiveArtifact({
      identity,
      previousSegmentSha256: first.sha256,
      events: [event(2)],
    });
    expect(() => validateLedgerArchiveChain([first, second])).not.toThrow();
    const fork = await createLedgerArchiveArtifact({
      identity,
      previousSegmentSha256: "sha256:wrong",
      events: [event(3)],
    });
    expect(() => validateLedgerArchiveChain([first, fork])).toThrow();
  });
});
