import { randomUUID } from "node:crypto";
import { describe, expect, it } from "@effect/vitest";
import { afterAll, beforeAll } from "vite-plus/test";
import { Effect } from "effect";
import { bindingMaterialRef } from "@agent-os/core/material-ref";
import { RUNTIME_FACT_OWNER } from "@agent-os/core/runtime-protocol";
import {
  DISPATCH_EVENT_KINDS,
  DELIVERY_RETRY_TRIGGER_KIND,
  backendProtocolEventIdentityKey,
  backendProtocolTruthIdentityKey,
} from "@agent-os/core/backend-protocol";
import { NodePostgresBackend, type NodePostgresEventSubscription } from "../../src/node";
import { safeIntegerFromDecimalText, safeIntegerSum } from "../../src/node/backend-helpers";
import { PsqlCli, quoteIdentifier, sqlJson, sqlString } from "../../src/node/host";
import {
  registerBackendConformanceSuite,
  type ContractDispatchReceiver,
  type RuntimeBackendContractDriver,
} from "@agent-os/runtime/testing";
import { startPostgresRuntimeHarnessEffect, type PostgresRuntimeHarness } from "./postgres-harness";
import { VITEST_BACKEND_CONFORMANCE_REGISTRAR } from "../backend-conformance-registrar";

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
    receiveConcurrent: (identity, envelopes) =>
      Promise.all(envelopes.map((envelope) => backend.receive(identity, envelope))),
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

registerBackendConformanceSuite(
  VITEST_BACKEND_CONFORMANCE_REGISTRAR,
  "node-postgres",
  makeNodePostgresContractDriver,
  {
    runtimeFactOwner: RUNTIME_FACT_OWNER,
    storageErrorTag: "agent_os.sql_error",
  },
);

describe("node-postgres event+due atomicity", () => {
  it("decodes only canonical decimal safe integers", () => {
    expect(safeIntegerFromDecimalText("0", "test id")).toBe(0);
    expect(safeIntegerFromDecimalText(String(-(2 ** 31)), "test id")).toBe(-(2 ** 31));
    expect(safeIntegerFromDecimalText(String(2 ** 31), "test id")).toBe(2 ** 31);
    expect(safeIntegerFromDecimalText(String(Number.MIN_SAFE_INTEGER), "test id")).toBe(
      Number.MIN_SAFE_INTEGER,
    );
    expect(safeIntegerFromDecimalText(String(Number.MAX_SAFE_INTEGER), "test id")).toBe(
      Number.MAX_SAFE_INTEGER,
    );

    for (const value of [
      Number.MAX_SAFE_INTEGER + 1,
      Number.MIN_SAFE_INTEGER - 1,
      0,
      "-0",
      "+1",
      "01",
      "1.0",
      " 1",
    ]) {
      expect(() => safeIntegerFromDecimalText(value, "test id")).toThrowError(
        expect.objectContaining({ _tag: "agent_os.sql_error" }),
      );
    }

    expect(safeIntegerSum(Number.MAX_SAFE_INTEGER - 1, 1, "test sum")).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(() => safeIntegerSum(Number.MAX_SAFE_INTEGER, 1, "test sum")).toThrowError(
      expect.objectContaining({ _tag: "agent_os.sql_error" }),
    );
  });

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

  it("rejects direct rows outside the durable lifecycle algebra", async () => {
    await withBackend("lifecycle_constraints", async (_backend, sql) => {
      const insert = (overrides: Record<string, string> = {}): Promise<void> => {
        const row = {
          identity_key: "'lifecycle-test'",
          identity: "'{}'::jsonb",
          fire_at: "10",
          kind: "'test.trigger'",
          payload: "'{}'::jsonb",
          completed_at: "NULL",
          claimed_at: "NULL",
          claim_token: "NULL",
          claim_deadline_at: "NULL",
          redrive_count: "0",
          cancel_requested_at: "NULL",
          cancel_reason: "NULL",
          cancelled_at: "NULL",
          ...overrides,
        };
        return sql.exec(`
          INSERT INTO agentos_due_work
            (identity_key, identity, fire_at, kind, payload, completed_at, claimed_at,
             claim_token, claim_deadline_at, redrive_count, cancel_requested_at,
             cancel_reason, cancelled_at)
          VALUES (${Object.values(row).join(", ")})
        `);
      };

      await expect(insert({ cancel_requested_at: "11" })).resolves.toBeUndefined();
      await expect(insert({ completed_at: "12" })).resolves.toBeUndefined();

      const illegal: ReadonlyArray<Record<string, string>> = [
        { claimed_at: "11" },
        { claim_token: "'claim'" },
        { claim_deadline_at: "12" },
        { claimed_at: "11", claim_token: "'claim'" },
        { claimed_at: "11", claim_deadline_at: "12" },
        { claim_token: "'claim'", claim_deadline_at: "12" },
        { claimed_at: "11", claim_token: "''", claim_deadline_at: "12" },
        { redrive_count: "1" },
        { redrive_count: "-1" },
        { cancel_reason: "'stop'" },
        { cancelled_at: "12" },
        { completed_at: "12", cancelled_at: "12" },
        { completed_at: "12", cancel_requested_at: "11", cancelled_at: "13" },
        { completed_at: "'Infinity'::double precision" },
        { claimed_at: "'NaN'::double precision" },
      ];
      for (const overrides of illegal) await expect(insert(overrides)).rejects.toBeTruthy();

      await insert();
      await expect(
        sql.exec("UPDATE agentos_due_work SET claimed_at = 11 WHERE kind = 'test.trigger'"),
      ).rejects.toBeTruthy();
    });
  });

  it("fails closed on a pre-existing unconstrained due-work schema", async () => {
    if (harness === undefined) throw new Error("postgres harness not started");
    const schema = `agentos_unconstrained_${randomUUID().replace(/-/g, "_")}`;
    const sql = new PsqlCli({ databaseUrl: harness.databaseUrl, schema });
    await sql.exec(`
      CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema)};
      CREATE TABLE agentos_due_work (
        id BIGSERIAL PRIMARY KEY,
        identity_key TEXT NOT NULL,
        identity JSONB NOT NULL,
        fire_at DOUBLE PRECISION NOT NULL,
        kind TEXT NOT NULL,
        payload JSONB NOT NULL
      );
    `);
    const backend = new NodePostgresBackend({
      databaseUrl: harness.databaseUrl,
      schema,
      bindingRef,
    });
    try {
      await expect(backend.initialize()).rejects.toBeTruthy();
    } finally {
      await backend.dispose();
    }
  });

  it("rejects same-name tautological lifecycle constraints", async () => {
    if (harness === undefined) throw new Error("postgres harness not started");
    const schema = `agentos_tautology_${randomUUID().replace(/-/g, "_")}`;
    const sql = new PsqlCli({ databaseUrl: harness.databaseUrl, schema });
    await sql.exec(`
      CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema)};
      CREATE TABLE agentos_due_work (
        id BIGSERIAL PRIMARY KEY,
        identity_key TEXT NOT NULL,
        identity JSONB NOT NULL,
        fire_at DOUBLE PRECISION NOT NULL,
        kind TEXT NOT NULL,
        payload JSONB NOT NULL,
        completed_at DOUBLE PRECISION,
        claimed_at DOUBLE PRECISION,
        claim_token TEXT,
        claim_deadline_at DOUBLE PRECISION,
        redrive_count INTEGER NOT NULL DEFAULT 0,
        cancel_requested_at DOUBLE PRECISION,
        cancel_reason TEXT,
        cancelled_at DOUBLE PRECISION,
        CONSTRAINT agentos_due_work_id_safe CHECK (TRUE),
        CONSTRAINT agentos_due_work_kind_nonempty CHECK (TRUE),
        CONSTRAINT agentos_due_work_finite_timestamps CHECK (TRUE),
        CONSTRAINT agentos_due_work_claim_tuple CHECK (TRUE),
        CONSTRAINT agentos_due_work_redrive_count CHECK (TRUE),
        CONSTRAINT agentos_due_work_redrive_claim CHECK (TRUE),
        CONSTRAINT agentos_due_work_cancel_reason CHECK (TRUE),
        CONSTRAINT agentos_due_work_cancelled_terminal CHECK (TRUE)
      );
    `);
    const backend = new NodePostgresBackend({
      databaseUrl: harness.databaseUrl,
      schema,
      bindingRef,
    });
    try {
      await expect(backend.initialize()).rejects.toBeTruthy();
    } finally {
      await backend.dispose();
    }
  });

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

  it("preserves archived ledger facts across exact eviction and restart", async () => {
    const identity = contractIdentity("node-archive");
    const otherTruth = contractIdentity("node-archive-other-truth");
    const otherOwner = { ...identity, factOwnerRef: "@test/node-archive-other-owner" };
    await withBackend("ledger_archive", async (backend, sql, restart) => {
      const commitIdentity = {
        scopeRef: identity.scopeRef,
        effectAuthorityRef: identity.effectAuthorityRef,
      };
      const [first] = await backend.commit([
        { ...commitIdentity, kind: "archive.a", payload: { value: 1 } },
      ]);
      const [interleaved] = await backend.commit([
        {
          scopeRef: otherTruth.scopeRef,
          effectAuthorityRef: otherTruth.effectAuthorityRef,
          kind: "archive.other-truth",
          payload: { value: 2 },
        },
      ]);
      const committed = await backend.commit([
        { ...commitIdentity, kind: "archive.b", payload: { value: 3 } },
        { ...commitIdentity, kind: "archive.c", payload: { value: 4 } },
      ]);
      await sql.exec(`
        INSERT INTO agentos_events
          (ts, kind, truth_key, identity_key, scope_ref, fact_owner_ref,
           effect_authority_ref, payload)
        VALUES (
          1, 'archive.other-owner',
          ${sqlString(backendProtocolTruthIdentityKey(otherOwner))},
          ${sqlString(backendProtocolEventIdentityKey(otherOwner))},
          ${sqlJson(otherOwner.scopeRef)}, ${sqlJson(otherOwner.factOwnerRef)},
          ${sqlJson(otherOwner.effectAuthorityRef)}, ${sqlJson({ value: 5 })}
        )
      `);
      const [{ id: otherOwnerEventIdText }] = await sql.json<{ readonly id: string }>(`
        SELECT MAX(id)::text AS id FROM agentos_events
      `);
      const otherOwnerEventId = safeIntegerFromDecimalText(
        otherOwnerEventIdText,
        "test other-owner event id",
      );
      const baseline = await backend.events(identity);
      const otherOwnerBaseline = await backend.events(otherOwner);
      const receipt = await backend.archiveLedger({
        identity,
        throughEventId: otherOwnerEventId!,
      });
      expect(await backend.events(identity)).toEqual(baseline);
      expect(await backend.events(otherOwner)).toEqual(otherOwnerBaseline);
      expect(await backend.evictArchivedLedger(receipt)).toEqual({ evicted: 4 });
      expect(await backend.events(identity)).toEqual(baseline);
      expect(await backend.events(otherOwner)).toEqual(otherOwnerBaseline);
      expect(await backend.events(otherTruth)).toEqual([interleaved]);
      const restarted = await restart();
      expect(await restarted.events(identity)).toEqual(baseline);
      expect(await restarted.events(otherOwner)).toEqual(otherOwnerBaseline);
      expect(await restarted.events(otherTruth)).toEqual([interleaved]);
      const later = await restarted.commit([
        { ...commitIdentity, kind: "archive.d", payload: { value: 6 } },
      ]);
      expect(later[0]!.id).toBeGreaterThan(otherOwnerEventId!);
      expect(first!.id).toBeLessThan(interleaved!.id);
      expect(interleaved!.id).toBeLessThan(committed[0]!.id);
    });
  });

  it("preserves identifiers above int32 across archive eviction and restart", async () => {
    const identity = contractIdentity("node-id-width");
    await withBackend("id_width", async (backend, sql, restart) => {
      const firstId = 2 ** 31;
      await sql.exec(`SELECT setval('agentos_events_id_seq', ${firstId}, false)`);
      const commitIdentity = {
        scopeRef: identity.scopeRef,
        effectAuthorityRef: identity.effectAuthorityRef,
      };
      const committed = await backend.commit([
        { ...commitIdentity, kind: "id-width.a", payload: { value: 1 } },
        { ...commitIdentity, kind: "id-width.b", payload: { value: 2 } },
      ]);
      expect(committed.map((event) => event.id)).toEqual([firstId, firstId + 1]);
      expect(await backend.events(identity)).toEqual(committed);

      const receipt = await backend.archiveLedger({
        identity,
        throughEventId: committed[1]!.id,
      });
      expect(receipt.firstEventId).toBe(firstId);
      expect(receipt.lastEventId).toBe(firstId + 1);
      expect(await backend.evictArchivedLedger(receipt)).toEqual({ evicted: 2 });
      expect(await backend.events(identity)).toEqual(committed);

      const restarted = await restart();
      expect(await restarted.events(identity)).toEqual(committed);
      const [later] = await restarted.commit([
        { ...commitIdentity, kind: "id-width.c", payload: { value: 3 } },
      ]);
      expect(later!.id).toBe(firstId + 2);

      await sql.exec(`SELECT setval('agentos_due_work_id_seq', ${firstId}, false)`);
      const scheduled = await restarted.schedule(identity, 100, "id-width.due", { value: 4 });
      expect(scheduled.id).toBe(firstId + 3);
      expect(await restarted.pendingDueCount(identity)).toBe(1);
      expect(await restarted.fireDue(identity, 100)).toEqual({ fired: 1 });
      expect(await restarted.pendingDueCount(identity)).toBe(0);
      expect((await restarted.events(identity)).map((event) => event.id)).toEqual([
        firstId,
        firstId + 1,
        firstId + 2,
        firstId + 3,
        firstId + 4,
      ]);
    });
  });

  it("rejects unsafe event and due-work identifiers without persisting rows", async () => {
    const identity = contractIdentity("node-id-unsafe");
    await withBackend("id_unsafe", async (backend, sql) => {
      await sql.exec(`SELECT setval('agentos_events_id_seq', ${Number.MAX_SAFE_INTEGER}, true)`);
      await expect(
        backend.commit([
          {
            scopeRef: identity.scopeRef,
            effectAuthorityRef: identity.effectAuthorityRef,
            kind: "id-width.unsafe",
            payload: { value: 1 },
          },
        ]),
      ).rejects.toMatchObject({ _tag: "agent_os.sql_error" });
      const [{ count: eventCount }] = await sql.json<{ readonly count: string }>(`
        SELECT COUNT(*)::text AS count FROM agentos_events
      `);
      expect(eventCount).toBe("0");

      await sql.exec(`
        SELECT setval('agentos_events_id_seq', 1, false);
        SELECT setval('agentos_due_work_id_seq', ${Number.MAX_SAFE_INTEGER}, true);
      `);
      await expect(
        backend.schedule(identity, 100, "id-width.unsafe-due", { value: 2 }),
      ).rejects.toMatchObject({ _tag: "agent_os.sql_error" });
      const [{ eventCountAfterDue, dueCount }] = await sql.json<{
        readonly eventCountAfterDue: string;
        readonly dueCount: string;
      }>(`
        SELECT
          (SELECT COUNT(*) FROM agentos_events)::text AS "eventCountAfterDue",
          (SELECT COUNT(*) FROM agentos_due_work)::text AS "dueCount"
      `);
      expect(eventCountAfterDue).toBe("0");
      expect(dueCount).toBe("0");
    });
  });

  it("linearizes archive successors across backend processes", async () => {
    const identity = contractIdentity("node-archive-concurrent");
    await withBackend("ledger_archive_concurrent", async (backend, _sql, restart) => {
      const commitIdentity = {
        scopeRef: identity.scopeRef,
        effectAuthorityRef: identity.effectAuthorityRef,
      };
      const committed = await backend.commit([
        { ...commitIdentity, kind: "archive.a", payload: { value: 1 } },
        { ...commitIdentity, kind: "archive.b", payload: { value: 2 } },
        { ...commitIdentity, kind: "archive.c", payload: { value: 3 } },
      ]);
      const baseline = await backend.events(identity);
      const competitor = await restart();
      const attempts = await Promise.allSettled([
        backend.archiveLedger({ identity, throughEventId: committed[0]!.id }),
        competitor.archiveLedger({ identity, throughEventId: committed[1]!.id }),
      ]);
      expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);
      const winner = attempts.find((result) => result.status === "fulfilled");
      if (winner?.status !== "fulfilled") expect.fail("expected one archive successor");
      expect(
        await competitor.archiveLedger({
          identity,
          throughEventId: winner.value.lastEventId,
        }),
      ).toEqual(winner.value);
      const tail = await backend.archiveLedger({
        identity,
        throughEventId: committed[2]!.id,
      });
      expect(tail.previousSegmentSha256).toBe(winner.value.segmentSha256);
      expect(await backend.events(identity)).toEqual(baseline);
      await competitor.evictArchivedLedger(winner.value);
      await competitor.corruptArchiveForTest(winner.value);
      await expect(backend.evictArchivedLedger(tail)).rejects.toBeTruthy();
      const [later] = await backend.commit([
        { ...commitIdentity, kind: "archive.d", payload: { value: 4 } },
      ]);
      await expect(
        competitor.archiveLedger({ identity, throughEventId: later!.id }),
      ).rejects.toBeTruthy();
    });
  });
});
