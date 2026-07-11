import { Effect, ManagedRuntime } from "effect";
import { describe, expect, it } from "@effect/vitest";
import {
  DurableTriggerRegistry,
  Ledger,
  TriggerPump,
  type AnyDurableTrigger,
} from "@agent-os/runtime";
import { RUNTIME_FACT_OWNER } from "@agent-os/core/runtime-protocol";
import type { BackendProtocolEventIdentity } from "@agent-os/core/backend-protocol";
import {
  commitDurableTriggerIntent,
  ensureDueWorkSchema,
  selectDurableProcessLifecycle,
} from "../../src/cloudflare/due-work";
import { EventBus } from "../../src/cloudflare/ledger/event-bus";
import { makeCloudflareBackendCoreLayer } from "../../src/cloudflare/runtime-core";
import { makeInMemoryDurableObjectState } from "./_in-memory-do";
import {
  runDurableProcessLifecycleContract,
  type DurableProcessLifecycleDriver,
} from "../../../core/test/backend-protocol/contract/durable-process-lifecycle-contract";

const makeDriver = (triggers: ReadonlyArray<AnyDurableTrigger>): DurableProcessLifecycleDriver => {
  const scope = "durable-process-lifecycle";
  const identity: BackendProtocolEventIdentity = {
    scopeRef: { kind: "conversation", scopeId: scope },
    effectAuthorityRef: { authorityClass: "effect", authorityId: scope },
    factOwnerRef: RUNTIME_FACT_OWNER,
  };
  const state = makeInMemoryDurableObjectState();
  const sql = state.storage.sql;
  const runtime = ManagedRuntime.make(
    makeCloudflareBackendCoreLayer(state, {}, scope, identity, new Map(), {}, triggers),
  );

  return {
    enqueue: async (trigger, payload, fireAt) => {
      await runtime.runPromise(Ledger);
      await runtime.runPromise(TriggerPump);
      const registry = await runtime.runPromise(
        Effect.gen(function* () {
          return yield* DurableTriggerRegistry;
        }),
      );
      const bus = await runtime.runPromise(EventBus);
      const event = await runtime.runPromise(
        commitDurableTriggerIntent(
          state,
          sql,
          bus,
          identity,
          fireAt,
          registry,
          trigger.kind,
          (tx, trigger) =>
            tx.append({
              ts: fireAt,
              kind: trigger.intentEventKind,
              scopeRef: identity.scopeRef,
              effectAuthorityRef: identity.effectAuthorityRef,
              payload,
            }),
        ),
      );
      return { id: event.id };
    },
    drainDue: async (now) => {
      const triggerPump = await runtime.runPromise(TriggerPump);
      await runtime.runPromise(triggerPump.drainDue(now));
    },
    cancel: async (triggerKind, intentEventId, reason) => {
      const triggerPump = await runtime.runPromise(TriggerPump);
      await runtime.runPromise(triggerPump.cancelTrigger({ triggerKind, intentEventId, reason }));
    },
    processes: () => runtime.runPromise(selectDurableProcessLifecycle(sql)),
    events: async () => {
      const ledger = await runtime.runPromise(Ledger);
      return runtime.runPromise(ledger.events(identity));
    },
    dispose: () => runtime.dispose(),
  };
};

describe("cloudflare-do durable process lifecycle", () => {
  runDurableProcessLifecycleContract("cloudflare-do", makeDriver);

  it.effect("rejects direct rows outside the durable lifecycle algebra", () =>
    Effect.gen(function* () {
      const sql = makeInMemoryDurableObjectState().storage.sql;
      yield* ensureDueWorkSchema(sql);
      const insert = (overrides: Record<string, unknown> = {}) => {
        const row = {
          fire_at: 10,
          kind: "test.trigger",
          payload: "{}",
          completed_at: null,
          claimed_at: null,
          claim_token: null,
          claim_deadline_at: null,
          redrive_count: 0,
          cancel_requested_at: null,
          cancel_reason: null,
          cancelled_at: null,
          ...overrides,
        };
        return sql.exec(
          `INSERT INTO due_work
            (fire_at, kind, payload, completed_at, claimed_at, claim_token,
             claim_deadline_at, redrive_count, cancel_requested_at, cancel_reason, cancelled_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
          ...Object.values(row),
        );
      };

      expect(() => insert({ cancel_requested_at: 11 })).not.toThrow();
      expect(() => insert({ completed_at: 12 })).not.toThrow();

      const illegal = [
        { claimed_at: 11 },
        { claim_token: "claim" },
        { claim_deadline_at: 12 },
        { claimed_at: 11, claim_token: "claim" },
        { claimed_at: 11, claim_deadline_at: 12 },
        { claim_token: "claim", claim_deadline_at: 12 },
        { claimed_at: 11, claim_token: "", claim_deadline_at: 12 },
        { redrive_count: 1 },
        { cancel_reason: "stop" },
        { cancelled_at: 12 },
        { completed_at: 12, cancelled_at: 12 },
        { completed_at: 12, cancel_requested_at: 11, cancelled_at: 13 },
        { completed_at: Number.POSITIVE_INFINITY },
      ];
      for (const overrides of illegal) expect(() => insert(overrides)).toThrow();

      const id = insert().one().id;
      expect(() => sql.exec("UPDATE due_work SET claimed_at = ? WHERE id = ?", 11, id)).toThrow();
    }),
  );

  it.effect("fails closed on a pre-existing unconstrained due-work schema", () =>
    Effect.gen(function* () {
      const sql = makeInMemoryDurableObjectState().storage.sql;
      sql.exec(`
        CREATE TABLE IF NOT EXISTS due_work (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          fire_at INTEGER NOT NULL,
          kind TEXT NOT NULL,
          payload TEXT NOT NULL
        )
      `);
      const rejected = yield* ensureDueWorkSchema(sql).pipe(
        Effect.match({ onFailure: () => true, onSuccess: () => false }),
      );
      expect(rejected).toBe(true);
    }),
  );

  it.effect("rejects same-name tautological lifecycle constraints", () =>
    Effect.gen(function* () {
      const sql = makeInMemoryDurableObjectState().storage.sql;
      sql.exec(`
        CREATE TABLE IF NOT EXISTS due_work (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          fire_at INTEGER NOT NULL,
          kind TEXT NOT NULL,
          payload TEXT NOT NULL,
          completed_at INTEGER,
          claimed_at INTEGER,
          claim_token TEXT,
          claim_deadline_at INTEGER,
          redrive_count INTEGER NOT NULL DEFAULT 0,
          cancel_requested_at INTEGER,
          cancel_reason TEXT,
          cancelled_at INTEGER,
          CONSTRAINT due_work_kind_nonempty CHECK (1 = 1),
          CONSTRAINT due_work_finite_timestamps CHECK (1 = 1),
          CONSTRAINT due_work_claim_tuple CHECK (1 = 1),
          CONSTRAINT due_work_redrive_count CHECK (1 = 1),
          CONSTRAINT due_work_redrive_claim CHECK (1 = 1),
          CONSTRAINT due_work_cancel_reason CHECK (1 = 1),
          CONSTRAINT due_work_cancelled_terminal CHECK (1 = 1)
        )
      `);
      const rejected = yield* ensureDueWorkSchema(sql).pipe(
        Effect.match({ onFailure: () => true, onSuccess: () => false }),
      );
      expect(rejected).toBe(true);
    }),
  );
});
