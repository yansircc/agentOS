import { ManagedRuntime } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { Ledger, LedgerArchive } from "@agent-os/runtime";
import { truthIdentity } from "./identity";
import { createTestInMemoryRuntimeBackend } from "./runtime-helper";

describe("in-memory ledger archive", () => {
  it("preserves one logical ledger across archive write, exact eviction, and later commits", async () => {
    const identity = truthIdentity("archive-seam");
    const other = truthIdentity("archive-other");
    const backend = createTestInMemoryRuntimeBackend({ identity });
    const runtime = ManagedRuntime.make(backend.layer);
    try {
      const ledger = await runtime.runPromise(Ledger);
      const archive = await runtime.runPromise(LedgerArchive);
      const first = await runtime.runPromise(
        ledger.commit([
          { ...identity, kind: "archive.a", payload: { value: 1 } },
          { ...other, kind: "archive.other", payload: { value: 2 } },
          { ...identity, kind: "archive.b", payload: { value: 3 } },
          { ...identity, kind: "archive.c", payload: { value: 4 } },
        ]),
      );
      const baseline = await runtime.runPromise(ledger.events(identity));
      const [receipt, retryReceipt] = await Promise.all([
        archive.archive({ identity, throughEventId: first[2]!.id }),
        archive.archive({ identity, throughEventId: first[2]!.id }),
      ]);
      expect(retryReceipt).toEqual(receipt);

      expect(await runtime.runPromise(ledger.events(identity))).toEqual(baseline);
      expect(await runtime.runPromise(ledger.streamSnapshot(identity))).toEqual(baseline);
      expect(
        await runtime.runPromise(ledger.events(identity, { afterId: first[0]!.id, limit: 1 })),
      ).toEqual([baseline[1]]);
      expect(await archive.evict(receipt)).toEqual({ evicted: 2 });
      expect(await runtime.runPromise(ledger.events(identity))).toEqual(baseline);
      expect(await runtime.runPromise(ledger.events(other))).toEqual([first[1]]);

      const secondReceipt = await archive.archive({
        identity,
        throughEventId: first[3]!.id,
      });
      expect(secondReceipt.previousSegmentSha256).toBe(receipt.segmentSha256);
      expect(await archive.evict(secondReceipt)).toEqual({ evicted: 1 });
      expect(await runtime.runPromise(ledger.events(identity))).toEqual(baseline);

      const later = await runtime.runPromise(
        ledger.commit([{ ...identity, kind: "archive.d", payload: { value: 5 } }]),
      );
      expect(later[0]!.id).toBeGreaterThan(first.at(-1)!.id);
      expect(await archive.evict(receipt)).toEqual({ evicted: 0 });
    } finally {
      await runtime.dispose();
    }
  });

  it("fails reads and eviction closed after archive tampering", async () => {
    const identity = truthIdentity("archive-tamper");
    const backend = createTestInMemoryRuntimeBackend({ identity });
    const runtime = ManagedRuntime.make(backend.layer);
    try {
      const ledger = await runtime.runPromise(Ledger);
      const archive = await runtime.runPromise(LedgerArchive);
      const committed = await runtime.runPromise(
        ledger.commit([{ ...identity, kind: "archive.fact", payload: { value: 1 } }]),
      );
      const receipt = await archive.archive({ identity, throughEventId: committed[0]!.id });
      await expect(
        archive.evict({ ...receipt, eventCount: receipt.eventCount + 1 }),
      ).rejects.toBeTruthy();
      backend.state.corruptArchiveForTest(receipt);
      await expect(runtime.runPromise(ledger.events(identity))).rejects.toBeTruthy();
      await expect(archive.evict(receipt)).rejects.toBeTruthy();
    } finally {
      await runtime.dispose();
    }
  });
});
