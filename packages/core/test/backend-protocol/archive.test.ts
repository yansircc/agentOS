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
