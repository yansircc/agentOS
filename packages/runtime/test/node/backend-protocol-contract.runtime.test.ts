import { randomUUID } from "node:crypto";
import { describe, expect, it } from "@effect/vitest";
import { afterAll, beforeAll } from "vite-plus/test";
import { Effect } from "effect";
import { bindingMaterialRef } from "@agent-os/core/material-ref";
import { RUNTIME_FACT_OWNER } from "@agent-os/core/runtime-protocol";
import { DISPATCH_EVENT_KINDS, DELIVERY_RETRY_TRIGGER_KIND } from "@agent-os/core/backend-protocol";
import { NodePostgresBackend, type NodePostgresEventSubscription } from "../../src/node";
import { PsqlCli } from "../../src/node/host";
import {
  runDispatchReceiveConcurrencyContract,
  runRuntimeBackendContractSuite,
  type ContractDispatchReceiver,
  type RuntimeBackendContractDriver,
} from "../../../core/test/backend-protocol/contract/runtime-backend-contract";
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
    commit: (events) => backend.commit(events),
    events: (identity, opts) => backend.events(identity, opts),
    streamSnapshot: (identity, opts) => backend.streamSnapshot(identity, opts),
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
    storageErrorTag: "agent_os.sql_error",
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

  const withBackend = async (
    testName: string,
    run: (
      backend: NodePostgresBackend,
      sql: PsqlCli,
      restart: () => Promise<NodePostgresBackend>,
    ) => Promise<void>,
  ): Promise<void> => {
    if (harness === undefined) throw new Error("postgres harness not started");
    const { databaseUrl } = harness;
    const schema = `agentos_atomic_${testName}_${randomUUID().replace(/-/g, "_")}`;
    let backend = new NodePostgresBackend({
      databaseUrl,
      schema,
      bindingRef,
    });
    const createdBackends = [backend];
    await backend.initialize();
    const sql = new PsqlCli({ databaseUrl, schema: backend.schema });
    const restart = async (): Promise<NodePostgresBackend> => {
      backend = new NodePostgresBackend({
        databaseUrl,
        schema,
        bindingRef,
      });
      await backend.initialize();
      createdBackends.push(backend);
      return backend;
    };
    try {
      await run(backend, sql, restart);
    } finally {
      await createdBackends[0]?.dispose();
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

  it("rolls back scheduled fire when due completion fails", async () => {
    const identity = contractIdentity("schedule-complete-atomic");
    await withBackend("schedule_complete", async (backend, sql, restart) => {
      await backend.schedule(identity, 100, "app.scheduled", { ok: true });
      await sql.exec(`
        CREATE OR REPLACE FUNCTION agentos_due_work_complete_fault()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          RAISE EXCEPTION 'fault-injected due_work completion failure';
        END;
        $$;
        CREATE TRIGGER agentos_due_work_complete_fault
        BEFORE UPDATE OF completed_at ON agentos_due_work
        FOR EACH ROW
        WHEN (OLD.completed_at IS NULL AND NEW.completed_at IS NOT NULL)
        EXECUTE FUNCTION agentos_due_work_complete_fault();
      `);

      await expect(backend.fireDue(identity, 100)).rejects.toBeTruthy();
      expect((await backend.events(identity)).map((event) => event.kind)).not.toContain(
        "app.scheduled",
      );
      expect(await backend.pendingDueCount(identity)).toBe(1);

      await sql.exec(`
        DROP TRIGGER agentos_due_work_complete_fault ON agentos_due_work;
        DROP FUNCTION agentos_due_work_complete_fault();
      `);
      const restarted = await restart();
      await restarted.fireDue(identity, 60_101);
      expect(
        (await restarted.events(identity)).filter((event) => event.kind === "app.scheduled"),
      ).toHaveLength(1);
      expect(await restarted.pendingDueCount(identity)).toBe(0);
    });
  });

  it("rolls back retry failure fact when next retry due insert fails", async () => {
    const source = contractIdentity("dispatch-retry-atomic-source");
    const target = contractIdentity("dispatch-retry-atomic-target");
    await withBackend("dispatch_retry", async (backend, sql, restart) => {
      backend.registerDispatchReceiver(target, () => Promise.reject("transient"));
      await backend.dispatchToScope(source, {
        target: {
          scopeRef: target.scopeRef,
          effectAuthorityRef: target.effectAuthorityRef,
          bindingRef,
        },
        event: "app.retry",
        data: { ok: true },
        idempotencyKey: "dispatch-retry-atomic",
      });
      const firstFailed = (await backend.events(source)).filter(
        (event) => event.kind === DISPATCH_EVENT_KINDS.OUTBOUND_FAILED,
      );
      expect(firstFailed).toHaveLength(1);
      const firstFailure = firstFailed[0];
      if (firstFailure === undefined) expect.fail("expected retry failure fact");
      const retryAt = (firstFailure.payload as { readonly nextAttemptAt?: number }).nextAttemptAt;
      expect(typeof retryAt).toBe("number");

      await sql.exec(`
        CREATE OR REPLACE FUNCTION agentos_retry_due_insert_fault()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          IF NEW.kind = '${DELIVERY_RETRY_TRIGGER_KIND}' THEN
            RAISE EXCEPTION 'fault-injected retry due_work insert failure';
          END IF;
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER agentos_retry_due_insert_fault
        BEFORE INSERT ON agentos_due_work
        FOR EACH ROW EXECUTE FUNCTION agentos_retry_due_insert_fault();
      `);

      await expect(backend.drainDispatchDue(source, retryAt!)).rejects.toBeTruthy();
      const failedAfterFault = (await backend.events(source)).filter(
        (event) => event.kind === DISPATCH_EVENT_KINDS.OUTBOUND_FAILED,
      );
      expect(failedAfterFault).toHaveLength(1);
      expect(await backend.pendingDueCount(source)).toBe(1);

      await sql.exec(`
        DROP TRIGGER agentos_retry_due_insert_fault ON agentos_due_work;
        DROP FUNCTION agentos_retry_due_insert_fault();
      `);
      const restarted = await restart();
      restarted.registerDispatchReceiver(target, () => Promise.reject("transient-again"));
      await restarted.drainDispatchDue(source, retryAt! + 60_001);
      const failedAfterRestart = (await restarted.events(source)).filter(
        (event) => event.kind === DISPATCH_EVENT_KINDS.OUTBOUND_FAILED,
      );
      expect(failedAfterRestart).toHaveLength(2);
      expect(await restarted.pendingDueCount(source)).toBe(1);
    });
  });
});
