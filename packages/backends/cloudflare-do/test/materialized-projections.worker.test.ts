import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { LedgerEventRpc } from "@agent-os/kernel/types";
import type { MaterializedProjectionTestDO } from "./test-worker";

interface TestEnv {
  readonly MATERIALIZED_PROJECTION_DO: DurableObjectNamespace<MaterializedProjectionTestDO>;
}

const testEnv = env as unknown as TestEnv;

describe("materialized projections — Cloudflare DO", () => {
  it("materializes projection rows from defineAgentDO projections", async () => {
    const scope = "materialized-projection-ok";
    const stub = testEnv.MATERIALIZED_PROJECTION_DO.get(
      testEnv.MATERIALIZED_PROJECTION_DO.idFromName(scope),
    );

    await runInDurableObject(stub, async (instance) => {
      await instance.emit("run.requested", { runId: "r1" });
      await instance.emit("run.completed", { runId: "r1", handoff: "ready" });

      const row = await instance.projectionGet({
        kind: "run.workflow",
        scope,
        identity: { runId: "r1" },
      });
      expect(row?.state).toEqual({ runId: "r1", status: "completed", handoff: "ready" });
      expect(row?.version).toBe(1);

      await expect(
        instance.projectionStatus({ kind: "run.workflow", scope }),
      ).resolves.toMatchObject({
        kind: "run.workflow",
        scope,
        version: 1,
        status: "current",
        lastAppliedEventId: 2,
      });
      await expect(instance.projectionList({ kind: "run.workflow", scope })).resolves.toHaveLength(
        1,
      );
      await expect(
        instance.projectionRebuild({ kind: "run.workflow", scope }),
      ).resolves.toMatchObject({
        kind: "run.workflow",
        scope,
        status: "current",
        rows: 1,
        lastRebuiltEventId: 2,
      });
    });
  });

  it("rolls back emitted ledger rows when projection reduce fails", async () => {
    const scope = "materialized-projection-rollback";
    const stub = testEnv.MATERIALIZED_PROJECTION_DO.get(
      testEnv.MATERIALIZED_PROJECTION_DO.idFromName(scope),
    );

    await runInDurableObject(stub, async (instance) => {
      await expect(instance.emit("run.failed", { runId: "r1" })).rejects.toMatchObject({
        _tag: "agent_os.sql_error",
      });
      const events: LedgerEventRpc[] = await instance.events();
      expect(events).toEqual([]);
      await expect(instance.projectionList({ kind: "run.workflow", scope })).resolves.toEqual([]);
    });
  });

  it("keeps current rows when rebuild fails", async () => {
    const scope = "materialized-projection-rebuild-swap";
    const stub = testEnv.MATERIALIZED_PROJECTION_DO.get(
      testEnv.MATERIALIZED_PROJECTION_DO.idFromName(scope),
    );

    await runInDurableObject(stub, async (instance) => {
      await instance.emit("run.requested", { runId: "r1" });
      await instance.emit("run.completed", { runId: "r1", handoff: "ready" });
      expect(
        await instance.projectionGet({
          kind: "run.workflow",
          scope,
          identity: { runId: "r1" },
        }),
      ).toMatchObject({
        version: 1,
        state: { runId: "r1", status: "completed", handoff: "ready" },
      });

      await expect(
        instance.rebuildWithFailingProjection({ kind: "run.workflow", scope }),
      ).rejects.toMatchObject({
        _tag: "agent_os.sql_error",
      });

      expect(
        await instance.projectionGet({
          kind: "run.workflow",
          scope,
          identity: { runId: "r1" },
        }),
      ).toMatchObject({
        version: 1,
        state: { runId: "r1", status: "completed", handoff: "ready" },
      });
    });
  });
});
