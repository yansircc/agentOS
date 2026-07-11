import { ManagedRuntime, Schema } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { backendProtocolEventIdentityKey } from "@agent-os/core/backend-protocol";
import {
  Ledger,
  LedgerArchive,
  MaterializedProjections,
  defineProjection,
  projectionFail,
  projectionIdentity,
  projectionMalformed,
  projectionPut,
  type AnyMaterializedProjectionDefinition,
} from "@agent-os/runtime";
import { projectionScopeKey, runtimeEventIdentity, truthIdentity } from "./identity";
import { createTestInMemoryRuntimeBackend, installTestProjectionRegistry } from "./runtime-helper";

const payload = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};

const WORKSPACE_OP_FACT_OWNER = "../../src/workspace-op-carrier";

const runWorkflowProjection = (version = 1): AnyMaterializedProjectionDefinition =>
  defineProjection({
    kind: "run.workflow",
    version,
    eventKinds: ["run.requested", "run.completed", "run.failed"],
    identity: Schema.Struct({ runId: Schema.String }),
    state: Schema.Struct({
      runId: Schema.String,
      status: Schema.Literals(["requested", "completed"]),
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

const failingRebuildProjection = (version = 2): AnyMaterializedProjectionDefinition =>
  defineProjection({
    ...runWorkflowProjection(version),
    reduce: (_state, event) =>
      event.kind === "run.completed"
        ? projectionFail("projection rebuild failed")
        : projectionPut({ runId: payload(event.payload).runId as string, status: "requested" }),
  });

const makeRuntime = (scope: string, projections = [runWorkflowProjection()]) => {
  const backend = createTestInMemoryRuntimeBackend({ identity: truthIdentity(scope), projections });
  const runtime = ManagedRuntime.make(backend.layer);
  return { backend, runtime };
};

describe("in-memory materialized projections", () => {
  it("updates projection rows atomically with ledger commits", async () => {
    const scope = "projection-ledger";
    const projectionScope = projectionScopeKey(scope);
    const projectionIdentitySpec = runtimeEventIdentity(scope);
    const { runtime } = makeRuntime(scope);
    try {
      const ledger = await runtime.runPromise(Ledger);
      const projections = await runtime.runPromise(MaterializedProjections);

      await runtime.runPromise(
        ledger.commit([
          { kind: "run.requested", payload: { runId: "r1" }, ...truthIdentity(scope) },
        ]),
      );
      await runtime.runPromise(
        ledger.commit([
          {
            kind: "run.completed",
            payload: { runId: "r1", handoff: "ready" },
            ...truthIdentity(scope),
          },
        ]),
      );

      const row = await runtime.runPromise(
        projections.get({
          kind: "run.workflow",
          ...projectionIdentitySpec,
          identity: { runId: "r1" },
        }),
      );
      expect(row?.state).toEqual({ runId: "r1", status: "completed", handoff: "ready" });
      expect(row?.version).toBe(1);

      const list = await runtime.runPromise(
        projections.list({ kind: "run.workflow", ...projectionIdentitySpec }),
      );
      expect(list.map((entry) => entry.identityKey)).toEqual(["r1"]);

      const status = await runtime.runPromise(
        projections.status({ kind: "run.workflow", ...projectionIdentitySpec }),
      );
      expect(status).toMatchObject({
        kind: "run.workflow",
        scope: projectionScope,
        version: 1,
        status: "current",
        lastAppliedEventId: 2,
      });
    } finally {
      await runtime.dispose();
    }
  });

  it("reads and rebuilds projections under the caller fact owner identity", async () => {
    const scope = "projection-owner-parity";
    const ownerIdentity = {
      ...truthIdentity(scope),
      factOwnerRef: WORKSPACE_OP_FACT_OWNER,
    };
    const projectionIdentitySpec = runtimeEventIdentity(scope);
    const { backend, runtime } = makeRuntime(scope);
    try {
      const projections = await runtime.runPromise(MaterializedProjections);

      await runtime.runPromise(
        backend.state.commitProtocolEvents([
          { ts: 1, kind: "run.requested", payload: { runId: "owned" }, ...ownerIdentity },
          {
            ts: 2,
            kind: "run.requested",
            payload: { runId: "runtime" },
            ...projectionIdentitySpec,
          },
          {
            ts: 3,
            kind: "run.completed",
            payload: { runId: "owned", handoff: "ready" },
            ...ownerIdentity,
          },
        ]),
      );

      const ownerRow = await runtime.runPromise(
        projections.get({
          kind: "run.workflow",
          ...ownerIdentity,
          identity: { runId: "owned" },
        }),
      );
      expect(ownerRow?.scope).toBe(backendProtocolEventIdentityKey(ownerIdentity));
      expect(ownerRow?.state).toEqual({ runId: "owned", status: "completed", handoff: "ready" });

      await expect(
        runtime.runPromise(projections.list({ kind: "run.workflow", ...ownerIdentity })),
      ).resolves.toMatchObject([{ identityKey: "owned" }]);
      await expect(
        runtime.runPromise(projections.list({ kind: "run.workflow", ...projectionIdentitySpec })),
      ).resolves.toMatchObject([{ identityKey: "runtime" }]);

      installTestProjectionRegistry(backend.state, [runWorkflowProjection(2)]);
      await expect(
        runtime.runPromise(projections.status({ kind: "run.workflow", ...ownerIdentity })),
      ).resolves.toMatchObject({ version: 2, status: "needs_rebuild" });

      const rebuilt = await runtime.runPromise(
        projections.rebuild({ kind: "run.workflow", ...ownerIdentity }),
      );
      expect(rebuilt).toMatchObject({
        kind: "run.workflow",
        scope: backendProtocolEventIdentityKey(ownerIdentity),
        version: 2,
        status: "current",
        rows: 1,
        lastAppliedEventId: 3,
        lastRebuiltEventId: 3,
      });
      await expect(
        runtime.runPromise(
          projections.get({
            kind: "run.workflow",
            ...projectionIdentitySpec,
            identity: { runId: "runtime" },
          }),
        ),
      ).resolves.toMatchObject({ version: 1 });
    } finally {
      await runtime.dispose();
    }
  });

  it("applies projections and event snapshots over canonical stored payloads", async () => {
    const scope = "projection-canonical-payload";
    const projectionIdentitySpec = runtimeEventIdentity(scope);
    const { runtime } = makeRuntime(scope);
    try {
      const ledger = await runtime.runPromise(Ledger);
      const projections = await runtime.runPromise(MaterializedProjections);
      const rawPayload = {
        runId: "raw",
        toJSON: () => ({ runId: "canonical" }),
      };
      Object.defineProperty(rawPayload, "secret", {
        value: "not-recorded",
        enumerable: false,
      });

      const committed = await runtime.runPromise(
        ledger.commit([{ kind: "run.requested", payload: rawPayload, ...truthIdentity(scope) }]),
      );

      expect(committed[0]?.payload).toEqual({ runId: "canonical" });
      const events = await runtime.runPromise(ledger.events(truthIdentity(scope)));
      expect(events[0]?.payload).toEqual({ runId: "canonical" });
      const row = await runtime.runPromise(
        projections.get({
          kind: "run.workflow",
          ...projectionIdentitySpec,
          identity: { runId: "canonical" },
        }),
      );
      expect(row?.state).toEqual({ runId: "canonical", status: "requested" });
    } finally {
      await runtime.dispose();
    }
  });

  it("rolls back the ledger commit when projection reduce fails", async () => {
    const scope = "projection-rollback";
    const projectionIdentitySpec = runtimeEventIdentity(scope);
    const { runtime } = makeRuntime(scope);
    try {
      const ledger = await runtime.runPromise(Ledger);
      const projections = await runtime.runPromise(MaterializedProjections);

      const exit = await runtime.runPromiseExit(
        ledger.commit([{ kind: "run.failed", payload: { runId: "r1" }, ...truthIdentity(scope) }]),
      );
      expect(exit._tag).toBe("Failure");
      await expect(runtime.runPromise(ledger.events(truthIdentity(scope)))).resolves.toEqual([]);
      await expect(
        runtime.runPromise(projections.list({ kind: "run.workflow", ...projectionIdentitySpec })),
      ).resolves.toEqual([]);
    } finally {
      await runtime.dispose();
    }
  });

  it("reports version mismatch and rebuilds rows from ledger", async () => {
    const scope = "projection-rebuild";
    const projectionScope = projectionScopeKey(scope);
    const projectionIdentitySpec = runtimeEventIdentity(scope);
    const { backend, runtime } = makeRuntime(scope);
    try {
      const ledger = await runtime.runPromise(Ledger);
      const archive = await runtime.runPromise(LedgerArchive);
      const projections = await runtime.runPromise(MaterializedProjections);

      await runtime.runPromise(
        ledger.commit([
          { kind: "run.requested", payload: { runId: "r1" }, ...truthIdentity(scope) },
        ]),
      );
      await runtime.runPromise(
        ledger.commit([
          {
            kind: "run.completed",
            payload: { runId: "r1", handoff: "done" },
            ...truthIdentity(scope),
          },
        ]),
      );

      const events = await runtime.runPromise(ledger.events(truthIdentity(scope)));
      const receipt = await archive.archive({
        identity: truthIdentity(scope),
        throughEventId: events[0]!.id,
      });
      await archive.evict(receipt);

      installTestProjectionRegistry(backend.state, [runWorkflowProjection(2)]);

      await expect(
        runtime.runPromise(projections.status({ kind: "run.workflow", ...projectionIdentitySpec })),
      ).resolves.toMatchObject({ version: 2, status: "needs_rebuild" });

      const rebuilt = await runtime.runPromise(
        projections.rebuild({ kind: "run.workflow", ...projectionIdentitySpec }),
      );
      expect(rebuilt).toMatchObject({
        kind: "run.workflow",
        scope: projectionScope,
        version: 2,
        status: "current",
        rows: 1,
        lastAppliedEventId: 2,
        lastRebuiltEventId: 2,
      });
      const row = await runtime.runPromise(
        projections.get({
          kind: "run.workflow",
          ...projectionIdentitySpec,
          identity: { runId: "r1" },
        }),
      );
      expect(row?.version).toBe(2);
      expect(row?.state).toEqual({ runId: "r1", status: "completed", handoff: "done" });
    } finally {
      await runtime.dispose();
    }
  });

  it("keeps current rows when rebuild fails", async () => {
    const scope = "projection-rebuild-swap";
    const projectionIdentitySpec = runtimeEventIdentity(scope);
    const { backend, runtime } = makeRuntime(scope);
    try {
      const ledger = await runtime.runPromise(Ledger);
      const projections = await runtime.runPromise(MaterializedProjections);

      await runtime.runPromise(
        ledger.commit([
          { kind: "run.requested", payload: { runId: "r1" }, ...truthIdentity(scope) },
        ]),
      );
      await runtime.runPromise(
        ledger.commit([
          {
            kind: "run.completed",
            payload: { runId: "r1", handoff: "done" },
            ...truthIdentity(scope),
          },
        ]),
      );

      installTestProjectionRegistry(backend.state, [failingRebuildProjection()]);

      const exit = await runtime.runPromiseExit(
        projections.rebuild({ kind: "run.workflow", ...projectionIdentitySpec }),
      );
      expect(exit._tag).toBe("Failure");

      const row = await runtime.runPromise(
        projections.get({
          kind: "run.workflow",
          ...projectionIdentitySpec,
          identity: { runId: "r1" },
        }),
      );
      expect(row?.version).toBe(1);
      expect(row?.state).toEqual({ runId: "r1", status: "completed", handoff: "done" });
      await expect(
        runtime.runPromise(projections.status({ kind: "run.workflow", ...projectionIdentitySpec })),
      ).resolves.toMatchObject({ version: 2, status: "needs_rebuild" });
    } finally {
      await runtime.dispose();
    }
  });
});
