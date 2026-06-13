import { randomUUID } from "node:crypto";
import { describe, expect, it } from "@effect/vitest";
import { afterAll, beforeAll } from "vite-plus/test";
import { Effect } from "effect";
import { bindingMaterialRef } from "@agent-os/kernel/material-ref";
import { RUNTIME_FACT_OWNER } from "@agent-os/runtime-protocol";
import { NodePostgresBackend, type NodePostgresEventSubscription } from "../src";
import { PsqlCli } from "../src/host";
import {
  runDispatchReceiveConcurrencyContract,
  runRuntimeBackendContractSuite,
  type ContractDispatchReceiver,
  type RuntimeBackendContractDriver,
} from "../../protocol/test/contract/runtime-backend-contract";
import { startPostgresRuntimeHarnessEffect, type PostgresRuntimeHarness } from "./postgres-harness";

const bindingRef = bindingMaterialRef({
  provider: "node",
  bindingKind: "postgres",
  ref: "receiver",
});

const contractIdentity = (scopeId: string) => ({
  scopeRef: { kind: "conversation" as const, scopeId },
  factOwnerRef: RUNTIME_FACT_OWNER,
  effectAuthorityRef: { authorityClass: "effect" as const, authorityId: scopeId },
});

let harness: PostgresRuntimeHarness | undefined;

beforeAll(async () => {
  harness = await Effect.runPromise(startPostgresRuntimeHarnessEffect); // eff-ignore EFF400 reason="vitest lifecycle hook starts the external Postgres harness"
}, 120_000);

afterAll(async () => {
  if (harness !== undefined) {
    await Effect.runPromise(harness.cleanup); // eff-ignore EFF400 reason="vitest lifecycle hook cleans up the external Postgres harness"
  }
}, 120_000);

const makeNodePostgresContractDriver = async (): Promise<RuntimeBackendContractDriver> => {
  if (harness === undefined) throw new Error("postgres harness not started");
  const backend = new NodePostgresBackend({
    databaseUrl: harness.databaseUrl,
    schema: `agentos_contract_${randomUUID().replace(/-/g, "_")}`,
    bindingRef,
  });
  await backend.initialize();
  return {
    bindingRef,
    registerDispatchReceiver: (identity, receiver?: ContractDispatchReceiver): void => {
      backend.registerDispatchReceiver(identity, receiver);
    },
    setDispatchTargetAdapter: (adapter): void => {
      backend.setDispatchTargetAdapter(adapter);
    },
    addHandler: (kind, handler): NodePostgresEventSubscription =>
      backend.addHandler(kind, (event) => Promise.resolve(handler(event))),
    addSink: (identity, kind, sink): NodePostgresEventSubscription =>
      backend.addSink(identity, kind, sink),
    telemetryDiagnostics: () => backend.telemetryDiagnostics(),
    log: (identity, kind, payload) => backend.log(identity, kind, payload),
    events: (identity) => backend.events(identity),
    schedule: (identity, at, eventKind, data) => backend.schedule(identity, at, eventKind, data),
    fireDue: (identity, now) => backend.fireDue(identity, now),
    dispatchToScope: (identity, spec) => backend.dispatchToScope(identity, spec),
    receive: (identity, envelope) => backend.receive(identity, envelope),
    drainDispatchDue: (identity, now) => backend.drainDispatchDue(identity, now),
    nextDueAt: (identity) => backend.nextDueAt(identity),
    pendingDueCount: (identity) => backend.pendingDueCount(identity),
    grantResource: (identity, spec) => backend.grantResource(identity, spec),
    reserveResource: (identity, spec) => backend.reserveResource(identity, spec),
    consumeResource: (identity, spec) => backend.consumeResource(identity, spec),
    releaseResource: (identity, spec) => backend.releaseResource(identity, spec),
    projectResource: (key) => backend.projectResource(key),
    quotaTryGrant: (identity, key, amount, windowMs, limit, toolName, operationRef) =>
      backend.quotaTryGrant(identity, key, amount, windowMs, limit, toolName, operationRef),
    dispose: () => backend.dispose(),
  };
};

describe("node-postgres backend protocol driver", () => {
  runRuntimeBackendContractSuite("node-postgres", makeNodePostgresContractDriver, {
    runtimeFactOwner: RUNTIME_FACT_OWNER,
  });
  runDispatchReceiveConcurrencyContract("node-postgres", makeNodePostgresContractDriver, {
    runtimeFactOwner: RUNTIME_FACT_OWNER,
  });
});

describe("node-postgres event+due atomicity", () => {
  const withDueInsertFailure = async (
    testName: string,
    run: (backend: NodePostgresBackend) => Promise<void>,
  ): Promise<void> => {
    if (harness === undefined) throw new Error("postgres harness not started");
    const backend = new NodePostgresBackend({
      databaseUrl: harness.databaseUrl,
      schema: `agentos_atomic_${testName}_${randomUUID().replace(/-/g, "_")}`,
      bindingRef,
    });
    await backend.initialize();
    const sql = new PsqlCli({ databaseUrl: harness.databaseUrl, schema: backend.schema });
    try {
      await sql.exec(`
        CREATE OR REPLACE FUNCTION agentos_due_work_insert_fault()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          RAISE EXCEPTION 'fault-injected due_work insert failure';
        END;
        $$;
        CREATE TRIGGER agentos_due_work_insert_fault
        BEFORE INSERT ON agentos_due_work
        FOR EACH ROW EXECUTE FUNCTION agentos_due_work_insert_fault();
      `);
      await run(backend);
    } finally {
      await backend.dispose();
    }
  };

  it("rolls back scheduled intent event when due-work insert fails", async () => {
    const identity = contractIdentity("schedule-atomic-rollback");
    await withDueInsertFailure("schedule", async (backend) => {
      await expect(
        backend.schedule(identity, 100, "app.scheduled", { ok: true }),
      ).rejects.toBeTruthy();
      expect(await backend.events(identity)).toEqual([]);
      expect(await backend.pendingDueCount(identity)).toBe(0);
    });
  });

  it("rolls back outbound dispatch event when delivery due-work insert fails", async () => {
    const source = contractIdentity("dispatch-atomic-source");
    const target = contractIdentity("dispatch-atomic-target");
    await withDueInsertFailure("dispatch", async (backend) => {
      backend.registerDispatchReceiver(target);
      await expect(
        backend.dispatchToScope(source, {
          target: {
            scopeRef: target.scopeRef,
            effectAuthorityRef: target.effectAuthorityRef,
            bindingRef,
          },
          event: "app.dispatch",
          data: { ok: true },
          idempotencyKey: "dispatch-atomic",
        }),
      ).rejects.toBeTruthy();
      expect(await backend.events(source)).toEqual([]);
      expect(await backend.pendingDueCount(source)).toBe(0);
    });
  });
});
