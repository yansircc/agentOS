import { ManagedRuntime, Schema } from "effect";
import { describe, expect, it } from "@effect/vitest";
import {
  Ledger,
  MaterializedProjections,
  defineProjection,
  makeProjectionRegistryResult,
  projectionFail,
  projectionIdentity,
  projectionMalformed,
  projectionPut,
  type AnyMaterializedProjectionDefinition,
} from "@agent-os/runtime";
import { createInMemoryRuntimeBackend } from "../src";

const payload = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};

const runWorkflowProjection = (version = 1): AnyMaterializedProjectionDefinition =>
  defineProjection({
    kind: "run.workflow",
    version,
    eventKinds: ["run.requested", "run.completed", "run.failed"],
    identity: Schema.Struct({ runId: Schema.String }),
    state: Schema.Struct({
      runId: Schema.String,
      status: Schema.Literal("requested", "completed"),
      handoff: Schema.optional(Schema.String),
    }),
    identityKey: (identity) => identity.runId,
    identify: (event) => {
      const runId = payload(event.payload).runId;
      return typeof runId === "string"
        ? projectionIdentity({ runId })
        : projectionMalformed("runId is required");
    },
    initial: (identity) => ({ runId: identity.runId, status: "requested" as const }),
    reduce: (state, event) => {
      if (event.kind === "run.failed") return projectionFail("projection refused run.failed");
      if (event.kind === "run.completed") {
        return projectionPut({
          ...state,
          status: "completed" as const,
          handoff:
            typeof payload(event.payload).handoff === "string"
              ? (payload(event.payload).handoff as string)
              : undefined,
        });
      }
      return projectionPut(state);
    },
  });

const makeRuntime = (scope: string, projections = [runWorkflowProjection()]) => {
  const backend = createInMemoryRuntimeBackend({ scope, projections });
  const runtime = ManagedRuntime.make(backend.layer);
  return { backend, runtime };
};

describe("in-memory materialized projections", () => {
  it("updates projection rows atomically with ledger commits", async () => {
    const scope = "projection-ledger";
    const { runtime } = makeRuntime(scope);
    try {
      const ledger = await runtime.runPromise(Ledger);
      const projections = await runtime.runPromise(MaterializedProjections);

      await runtime.runPromise(ledger.log("run.requested", { runId: "r1" }, scope));
      await runtime.runPromise(
        ledger.log("run.completed", { runId: "r1", handoff: "ready" }, scope),
      );

      const row = await runtime.runPromise(
        projections.get({ kind: "run.workflow", scope, identity: { runId: "r1" } }),
      );
      expect(row?.state).toEqual({ runId: "r1", status: "completed", handoff: "ready" });
      expect(row?.version).toBe(1);

      const list = await runtime.runPromise(projections.list({ kind: "run.workflow", scope }));
      expect(list.map((entry) => entry.identityKey)).toEqual(["r1"]);

      const status = await runtime.runPromise(projections.status({ kind: "run.workflow", scope }));
      expect(status).toMatchObject({
        kind: "run.workflow",
        scope,
        version: 1,
        status: "current",
        lastAppliedEventId: 2,
      });
    } finally {
      await runtime.dispose();
    }
  });

  it("rolls back the ledger commit when projection reduce fails", async () => {
    const scope = "projection-rollback";
    const { runtime } = makeRuntime(scope);
    try {
      const ledger = await runtime.runPromise(Ledger);
      const projections = await runtime.runPromise(MaterializedProjections);

      const exit = await runtime.runPromiseExit(ledger.log("run.failed", { runId: "r1" }, scope));
      expect(exit._tag).toBe("Failure");
      await expect(runtime.runPromise(ledger.events(scope))).resolves.toEqual([]);
      await expect(
        runtime.runPromise(projections.list({ kind: "run.workflow", scope })),
      ).resolves.toEqual([]);
    } finally {
      await runtime.dispose();
    }
  });

  it("reports version mismatch and rebuilds rows from ledger", async () => {
    const scope = "projection-rebuild";
    const { backend, runtime } = makeRuntime(scope);
    try {
      const ledger = await runtime.runPromise(Ledger);
      const projections = await runtime.runPromise(MaterializedProjections);

      await runtime.runPromise(ledger.log("run.requested", { runId: "r1" }, scope));
      await runtime.runPromise(
        ledger.log("run.completed", { runId: "r1", handoff: "done" }, scope),
      );

      backend.state.setProjectionRegistryResult(
        makeProjectionRegistryResult([runWorkflowProjection(2)]),
      );

      await expect(
        runtime.runPromise(projections.status({ kind: "run.workflow", scope })),
      ).resolves.toMatchObject({ version: 2, status: "needs_rebuild" });

      const rebuilt = await runtime.runPromise(
        projections.rebuild({ kind: "run.workflow", scope }),
      );
      expect(rebuilt).toMatchObject({
        kind: "run.workflow",
        scope,
        version: 2,
        status: "current",
        rows: 1,
        lastAppliedEventId: 2,
        lastRebuiltEventId: 2,
      });
      const row = await runtime.runPromise(
        projections.get({ kind: "run.workflow", scope, identity: { runId: "r1" } }),
      );
      expect(row?.version).toBe(2);
      expect(row?.state).toEqual({ runId: "r1", status: "completed", handoff: "done" });
    } finally {
      await runtime.dispose();
    }
  });
});
