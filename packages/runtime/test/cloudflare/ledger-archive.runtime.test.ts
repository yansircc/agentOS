import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { RUNTIME_FACT_OWNER } from "@agent-os/core/runtime-protocol";
import type { BackendProtocolContractTestDO } from "./test-worker";

interface TestEnv {
  readonly BACKEND_PROTOCOL_CONTRACT_DO: DurableObjectNamespace<BackendProtocolContractTestDO>;
}

const testEnv = env as unknown as TestEnv;
const identity = (scopeId: string) => ({
  scopeRef: { kind: "conversation" as const, scopeId },
  effectAuthorityRef: { authorityClass: "effect" as const, authorityId: scopeId },
  factOwnerRef: RUNTIME_FACT_OWNER,
});

describe("cloudflare ledger archive", () => {
  it("linearizes concurrent successors of one archive predecessor", async () => {
    const key = `ledger-archive-concurrent-${crypto.randomUUID()}`;
    const stub = testEnv.BACKEND_PROTOCOL_CONTRACT_DO.get(
      testEnv.BACKEND_PROTOCOL_CONTRACT_DO.idFromName(key),
    );
    await runInDurableObject(stub, async (instance) => {
      instance.configure({ idPrefix: `${key}-` });
      const truth = identity(key);
      const commitIdentity = {
        scopeRef: truth.scopeRef,
        effectAuthorityRef: truth.effectAuthorityRef,
      };
      const committed = await instance.commit([
        { ...commitIdentity, kind: "archive.a", payload: { value: 1 } },
        { ...commitIdentity, kind: "archive.b", payload: { value: 2 } },
        { ...commitIdentity, kind: "archive.c", payload: { value: 3 } },
      ]);
      const baseline = await instance.events(truth);
      const attempts = await Promise.allSettled([
        instance.archiveLedger(truth, committed[0]!.id),
        instance.archiveLedger(truth, committed[1]!.id),
      ]);
      expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);
      const winner = attempts.find((result) => result.status === "fulfilled");
      if (winner?.status !== "fulfilled") expect.fail("expected one archive successor");
      expect(await instance.archiveLedger(truth, winner.value.lastEventId)).toEqual(winner.value);
      const tail = await instance.archiveLedger(truth, committed[2]!.id);
      expect(tail.previousSegmentSha256).toBe(winner.value.segmentSha256);
      expect(await instance.events(truth)).toEqual(baseline);
      await instance.evictArchivedLedger(winner.value);
      instance.corruptArchiveForTest(winner.value);
      await expect(instance.evictArchivedLedger(tail)).rejects.toBeTruthy();
      const [later] = await instance.commit([
        { ...commitIdentity, kind: "archive.d", payload: { value: 4 } },
      ]);
      await expect(instance.archiveLedger(truth, later!.id)).rejects.toBeTruthy();
    });
  });

  it("preserves hot-cold reads and monotonic ids after exact eviction", async () => {
    const key = `ledger-archive-${crypto.randomUUID()}`;
    const stub = testEnv.BACKEND_PROTOCOL_CONTRACT_DO.get(
      testEnv.BACKEND_PROTOCOL_CONTRACT_DO.idFromName(key),
    );
    await runInDurableObject(stub, async (instance) => {
      instance.configure({ idPrefix: `${key}-` });
      const truth = identity(key);
      const commitIdentity = {
        scopeRef: truth.scopeRef,
        effectAuthorityRef: truth.effectAuthorityRef,
      };
      const committed = await instance.commit([
        { ...commitIdentity, kind: "archive.a", payload: { value: 1 } },
        { ...commitIdentity, kind: "archive.b", payload: { value: 2 } },
        { ...commitIdentity, kind: "archive.c", payload: { value: 3 } },
      ]);
      const baseline = await instance.events(truth);
      const receipt = await instance.archiveLedger(truth, committed[1]!.id);
      expect(await instance.events(truth)).toEqual(baseline);
      expect(await instance.streamSnapshot(truth)).toEqual(baseline);
      expect(await instance.evictArchivedLedger(receipt)).toEqual({ evicted: 2 });
      expect(await instance.events(truth)).toEqual(baseline);
      expect(await instance.streamSnapshot(truth)).toEqual(baseline);
      const later = await instance.commit([
        { ...commitIdentity, kind: "archive.d", payload: { value: 4 } },
      ]);
      expect(later[0]!.id).toBeGreaterThan(committed.at(-1)!.id);
    });
  });

  it("fails reads and eviction closed after archive corruption", async () => {
    const key = `ledger-archive-corrupt-${crypto.randomUUID()}`;
    const stub = testEnv.BACKEND_PROTOCOL_CONTRACT_DO.get(
      testEnv.BACKEND_PROTOCOL_CONTRACT_DO.idFromName(key),
    );
    await runInDurableObject(stub, async (instance) => {
      instance.configure({ idPrefix: `${key}-` });
      const truth = identity(key);
      const commitIdentity = {
        scopeRef: truth.scopeRef,
        effectAuthorityRef: truth.effectAuthorityRef,
      };
      const committed = await instance.commit([
        { ...commitIdentity, kind: "archive.fact", payload: { value: 1 } },
      ]);
      const receipt = await instance.archiveLedger(truth, committed[0]!.id);
      instance.corruptArchiveForTest(receipt);
      await expect(instance.events(truth)).rejects.toBeTruthy();
      await expect(instance.evictArchivedLedger(receipt)).rejects.toBeTruthy();
    });
  });
});
