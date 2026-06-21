import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";

import type {
  TriggerBoundaryTestDO,
  TriggerCancelTestDO,
  TriggerFacadeTestDO,
  TriggerFactoryErrorTestDO,
  TriggerTestingDrainTestDO,
} from "./test-worker";
import { testTruthIdentity } from "./_identity";

interface TestEnv {
  readonly TRIGGER_FACADE_DO: DurableObjectNamespace<TriggerFacadeTestDO>;
  readonly TRIGGER_FACTORY_ERROR_DO: DurableObjectNamespace<TriggerFactoryErrorTestDO>;
  readonly TRIGGER_BOUNDARY_DO: DurableObjectNamespace<TriggerBoundaryTestDO>;
  readonly TRIGGER_CANCEL_DO: DurableObjectNamespace<TriggerCancelTestDO>;
  readonly TRIGGER_TESTING_DRAIN_DO: DurableObjectNamespace<TriggerTestingDrainTestDO>;
}

const testEnv = env as unknown as TestEnv;
const CANCEL_TEST_AT = 9_000_000_000_000;

describe("defineAgentDO trigger facade", () => {
  it("rejects unregistered trigger enqueue before writing intent or due work", async () => {
    const stub = testEnv.TRIGGER_FACADE_DO.get(
      testEnv.TRIGGER_FACADE_DO.idFromName("trigger-facade-unregistered"),
    );

    let rejected: unknown;
    try {
      await runInDurableObject(stub, (instance) =>
        instance.enqueueTrigger({
          triggerKind: "missing.trigger",
          payload: { label: "never" },
          at: 10,
        }),
      );
    } catch (cause) {
      rejected = cause;
    }
    expect(String(rejected)).toContain("agent_os.unregistered_durable_trigger_kind");

    const events = (await stub.events(testTruthIdentity("trigger-facade-unregistered"))) as Array<{
      readonly kind: string;
      readonly payload: unknown;
    }>;
    expect(events).toHaveLength(0);
  });

  it("wraps trigger factory failure as typed error before intent due-work or alarm writes", async () => {
    const stub = testEnv.TRIGGER_FACTORY_ERROR_DO.get(
      testEnv.TRIGGER_FACTORY_ERROR_DO.idFromName("trigger-factory-error"),
    );

    const result = await runInDurableObject(stub, async (instance, state) => {
      let rejected: unknown;
      try {
        await instance.enqueueTrigger({
          triggerKind: "any.trigger",
          payload: { label: "never" },
          at: 10,
        });
      } catch (cause) {
        rejected = cause;
      }
      const sql = state.storage.sql;
      const hasEventsTable =
        sql
          .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events'")
          .toArray().length > 0;
      const hasDueTable =
        sql
          .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'due_work'")
          .toArray().length > 0;
      return {
        tag: (rejected as { readonly _tag?: string } | undefined)?._tag,
        events: hasEventsTable ? sql.exec("SELECT * FROM events").toArray().length : 0,
        due: hasDueTable ? sql.exec("SELECT * FROM due_work").toArray().length : 0,
        alarm: await state.storage.getAlarm(),
      };
    });

    expect(result).toEqual({
      tag: "agent_os.trigger_factory_error",
      events: 0,
      due: 0,
      alarm: null,
    });
  });

  it("enqueues registered triggers and lets commit fold ledger rows inside the tx", async () => {
    const stub = testEnv.TRIGGER_FACADE_DO.get(
      testEnv.TRIGGER_FACADE_DO.idFromName("trigger-facade-fold"),
    );

    const events = await runInDurableObject(stub, async (instance) => {
      await instance.enqueueTrigger({
        triggerKind: "test.fold",
        payload: { label: "one" },
        at: 1,
      });
      await instance.enqueueTrigger({
        triggerKind: "test.fold",
        payload: { label: "two" },
        at: 1,
      });
      const alarmInstance = instance as TriggerFacadeTestDO & {
        readonly alarm: () => Promise<void>;
      };
      await alarmInstance.alarm();
      return instance.events(testTruthIdentity("trigger-facade-fold"));
    });

    expect(events.filter((event) => event.kind === "test.fold.requested")).toHaveLength(2);
    expect(
      events.filter((event) => event.kind === "test.fold.done").map((event) => event.payload),
    ).toEqual([
      { label: "one", seen: 0 },
      { label: "two", seen: 1 },
    ]);
  });

  it("exposes canonical payloads through trigger tx append results", async () => {
    const stub = testEnv.TRIGGER_FACADE_DO.get(
      testEnv.TRIGGER_FACADE_DO.idFromName("trigger-facade-canonical-tx"),
    );

    const events = await runInDurableObject(stub, async (instance) => {
      await instance.enqueueTrigger({
        triggerKind: "test.trigger_canonical_tx",
        payload: { label: "observe" },
        at: 1,
      });
      const alarmInstance = instance as TriggerFacadeTestDO & {
        readonly alarm: () => Promise<void>;
      };
      await alarmInstance.alarm();
      return instance.events(testTruthIdentity("trigger-facade-canonical-tx"));
    });

    const observed = events.find((event) => event.kind === "test.trigger_canonical_tx.observed");
    expect(observed?.payload).toEqual({
      inserted: { visible: "stored", hasSecret: false },
      enqueued: { visible: "stored", hasSecret: false },
    });
  });

  it("does not expose production drain methods on the default facade", async () => {
    const stub = testEnv.TRIGGER_FACADE_DO.get(
      testEnv.TRIGGER_FACADE_DO.idFromName("trigger-facade-no-prod-drain"),
    );

    const keys = await runInDurableObject(stub, (instance) => ({
      drainDue: "drainDue" in instance,
      drainUntilQuiet: "drainUntilQuiet" in instance,
      testingDrain: "__drainUntilQuietForTesting" in instance,
    }));

    expect(keys).toEqual({
      drainDue: false,
      drainUntilQuiet: false,
      testingDrain: false,
    });
  });

  it("rolls back ledger and projection writes when trigger commit fails", async () => {
    const stub = testEnv.TRIGGER_BOUNDARY_DO.get(
      testEnv.TRIGGER_BOUNDARY_DO.idFromName("trigger-rollback-projection"),
    );

    const result = await runInDurableObject(stub, async (instance, state) => {
      await instance.enqueueTrigger({
        triggerKind: "test.rollback_projection",
        payload: { label: "one" },
        at: 10,
      });
      const alarmInstance = instance as TriggerBoundaryTestDO & {
        readonly alarm: () => Promise<void>;
      };
      let rejected = false;
      try {
        await alarmInstance.alarm();
      } catch {
        rejected = true;
      }
      const sql = state.storage.sql;
      return {
        rejected,
        requested: sql
          .exec("SELECT * FROM events WHERE kind = 'test.rollback_projection.requested'")
          .toArray().length,
        done: sql
          .exec("SELECT * FROM events WHERE kind = 'test.rollback_projection.done'")
          .toArray().length,
        projection: sql.exec("SELECT * FROM test_projection").toArray().length,
        pendingDue: sql.exec("SELECT * FROM due_work WHERE completed_at IS NULL").toArray().length,
      };
    });

    expect(result).toEqual({
      rejected: true,
      requested: 1,
      done: 0,
      projection: 0,
      pendingDue: 1,
    });
  });

  it("rejects thenable trigger commit and keeps the due row pending", async () => {
    const stub = testEnv.TRIGGER_BOUNDARY_DO.get(
      testEnv.TRIGGER_BOUNDARY_DO.idFromName("trigger-thenable-commit"),
    );

    const result = await runInDurableObject(stub, async (instance, state) => {
      await instance.enqueueTrigger({
        triggerKind: "test.thenable_commit",
        payload: { label: "two" },
        at: 10,
      });
      const alarmInstance = instance as TriggerBoundaryTestDO & {
        readonly alarm: () => Promise<void>;
      };
      let tag: string | undefined;
      try {
        await alarmInstance.alarm();
      } catch (cause) {
        tag = (cause as { readonly _tag?: string })._tag;
      }
      const sql = state.storage.sql;
      return {
        tag,
        done: sql.exec("SELECT * FROM events WHERE kind = 'test.thenable_commit.done'").toArray()
          .length,
        pendingDue: sql.exec("SELECT * FROM due_work WHERE completed_at IS NULL").toArray().length,
      };
    });

    expect(result).toEqual({
      tag: "agent_os.durable_trigger_commit_returned_thenable",
      done: 0,
      pendingDue: 1,
    });
  });

  it("exposes explicit testing drain-until-quiet through the testing wrapper only", async () => {
    const stub = testEnv.TRIGGER_TESTING_DRAIN_DO.get(
      testEnv.TRIGGER_TESTING_DRAIN_DO.idFromName("trigger-testing-drain-chain"),
    );

    const result = await runInDurableObject(stub, async (instance) => {
      await instance.enqueueTrigger({
        triggerKind: "test.chain",
        payload: { step: 1 },
        at: 10,
      });
      const once = await instance.__drainDueOnceForTesting({ now: 10 });
      const untilQuiet = await instance.__drainUntilQuietForTesting({ now: 10 });
      const events = await instance.events(testTruthIdentity("trigger-testing-drain-chain"));
      return {
        once,
        untilQuiet,
        doneSteps: events
          .filter((event) => event.kind === "test.chain.done")
          .map((event) => (event.payload as { readonly step: number }).step),
      };
    });

    expect(result).toEqual({
      once: { drained: 1 },
      untilQuiet: { drained: 2, iterations: 3 },
      doneSteps: [1, 2, 3],
    });
  });

  it("cancels a running trigger cooperatively and commits the trigger cancellation hook", async () => {
    const stub = testEnv.TRIGGER_CANCEL_DO.get(
      testEnv.TRIGGER_CANCEL_DO.idFromName("trigger-running-cancel"),
    );

    const intent = await runInDurableObject(stub, (instance) =>
      instance.enqueueTrigger({
        triggerKind: "test.cancellable",
        payload: { label: "one" },
        at: CANCEL_TEST_AT,
      }),
    );
    const drain = runInDurableObject(stub, (instance) =>
      instance.__drainDueOnceForTesting({ now: CANCEL_TEST_AT }),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    const cancel = await runInDurableObject(stub, (instance) =>
      instance.cancelTrigger({
        triggerKind: "test.cancellable",
        intentEventId: intent.id,
        reason: "user",
      }),
    );
    await drain;
    const events = (await stub.events(testTruthIdentity("trigger-running-cancel"))) as Array<{
      readonly kind: string;
      readonly payload: unknown;
    }>;
    const result = {
      cancel,
      done: events.filter((event) => event.kind === "test.cancellable.done").length,
      cancelled: events
        .filter((event) => event.kind === "test.cancellable.cancelled")
        .map((event) => event.payload),
    };

    expect(result).toEqual({
      cancel: { status: "requested", requested: 1 },
      done: 0,
      cancelled: [{ label: "one", reason: "user" }],
    });
  });

  it("returns ignored without mutating due-work for ignored triggers", async () => {
    const stub = testEnv.TRIGGER_CANCEL_DO.get(
      testEnv.TRIGGER_CANCEL_DO.idFromName("trigger-ignored-cancel"),
    );

    const result = await runInDurableObject(stub, async (instance, state) => {
      const intent = await instance.enqueueTrigger({
        triggerKind: "test.generic_cancel",
        payload: { label: "two" },
        at: CANCEL_TEST_AT,
      });
      const cancel = await instance.cancelTrigger({
        triggerKind: "test.generic_cancel",
        intentEventId: intent.id,
        reason: "user",
      });
      const duplicate = await instance.cancelTrigger({
        triggerKind: "test.generic_cancel",
        intentEventId: intent.id,
        reason: "user",
      });
      const events = await instance.events(testTruthIdentity("trigger-ignored-cancel"));
      return {
        cancel,
        duplicate,
        eventKinds: events.map((event) => event.kind),
        due: state.storage.sql
          .exec("SELECT completed_at, cancel_requested_at, cancel_reason FROM due_work")
          .toArray(),
      };
    });

    expect(result).toEqual({
      cancel: { status: "ignored" },
      duplicate: { status: "ignored" },
      eventKinds: ["test.generic_cancel.requested"],
      due: [{ completed_at: null, cancel_requested_at: null, cancel_reason: null }],
    });
  });

  it("rejects thenable cancellation commits and keeps the due row pending", async () => {
    const stub = testEnv.TRIGGER_CANCEL_DO.get(
      testEnv.TRIGGER_CANCEL_DO.idFromName("trigger-thenable-cancel"),
    );

    const result = await runInDurableObject(stub, async (instance, state) => {
      const intent = await instance.enqueueTrigger({
        triggerKind: "test.thenable_cancel",
        payload: { label: "cancel" },
        at: CANCEL_TEST_AT,
      });
      let tag: string | undefined;
      try {
        await instance.cancelTrigger({
          triggerKind: "test.thenable_cancel",
          intentEventId: intent.id,
          reason: "user",
        });
      } catch (cause) {
        tag = (cause as { readonly _tag?: string })._tag;
      }
      const sql = state.storage.sql;
      return {
        tag,
        cancelled: sql
          .exec("SELECT * FROM events WHERE kind = 'test.thenable_cancel.cancelled'")
          .toArray().length,
        pendingDue: sql.exec("SELECT * FROM due_work WHERE completed_at IS NULL").toArray().length,
      };
    });

    expect(result).toEqual({
      tag: "agent_os.durable_trigger_commit_returned_thenable",
      cancelled: 0,
      pendingDue: 1,
    });
  });

  it("lets concurrent drains claim a due row only once", async () => {
    const stub = testEnv.TRIGGER_CANCEL_DO.get(
      testEnv.TRIGGER_CANCEL_DO.idFromName("trigger-concurrent-drain-single-claim"),
    );

    await runInDurableObject(stub, (instance) =>
      instance.enqueueTrigger({
        triggerKind: "test.default_deadline",
        payload: { label: "concurrent" },
        at: CANCEL_TEST_AT,
      }),
    );
    const first = runInDurableObject(stub, (instance) =>
      instance.__drainDueOnceForTesting({ now: CANCEL_TEST_AT }),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await runInDurableObject(stub, (instance) =>
      instance.__drainDueOnceForTesting({ now: CANCEL_TEST_AT }),
    );
    const firstResult = await first;
    const events = (await stub.events(
      testTruthIdentity("trigger-concurrent-drain-single-claim"),
    )) as Array<{ readonly kind: string }>;

    expect({
      first: firstResult,
      second,
      done: events.filter((event) => event.kind === "test.default_deadline.done").length,
    }).toEqual({
      first: { drained: 1 },
      second: { drained: 0 },
      done: 1,
    });
  });

  it("redrives expired claims and lets only one terminal commit win", async () => {
    const stub = testEnv.TRIGGER_CANCEL_DO.get(
      testEnv.TRIGGER_CANCEL_DO.idFromName("trigger-redrive-single-terminal"),
    );

    await runInDurableObject(stub, (instance) =>
      instance.enqueueTrigger({
        triggerKind: "test.redrive_once",
        payload: { label: "three" },
        at: CANCEL_TEST_AT,
      }),
    );
    const first = runInDurableObject(stub, (instance) =>
      instance.__drainDueOnceForTesting({ now: CANCEL_TEST_AT }),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    await runInDurableObject(stub, (instance) =>
      instance.__drainDueOnceForTesting({ now: CANCEL_TEST_AT + 2 }),
    );
    await first;
    const result = await runInDurableObject(stub, async (instance, state) => {
      const events = await instance.events(testTruthIdentity("trigger-redrive-single-terminal"));
      const observations = state.storage.sql
        .exec("SELECT mode, aborted FROM test_acquire_observations ORDER BY rowid")
        .toArray();
      return {
        done: events.filter((event) => event.kind === "test.redrive_once.done").length,
        observations,
      };
    });

    expect(result).toEqual({
      done: 1,
      observations: [
        { mode: "normal", aborted: 0 },
        { mode: "redrive", aborted: 0 },
      ],
    });
  });

  it("propagates a cancel request across redrive by starting the redrive signal aborted", async () => {
    const stub = testEnv.TRIGGER_CANCEL_DO.get(
      testEnv.TRIGGER_CANCEL_DO.idFromName("trigger-redrive-cancel-propagates"),
    );

    const intent = await runInDurableObject(stub, (instance) =>
      instance.enqueueTrigger({
        triggerKind: "test.redrive_cancelled",
        payload: { label: "four" },
        at: CANCEL_TEST_AT,
      }),
    );
    const first = runInDurableObject(stub, (instance) =>
      instance.__drainDueOnceForTesting({ now: CANCEL_TEST_AT }),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    const cancel = await runInDurableObject(stub, (instance) =>
      instance.cancelTrigger({
        triggerKind: "test.redrive_cancelled",
        intentEventId: intent.id,
        reason: "stop",
      }),
    );
    const second = await runInDurableObject(stub, (instance) =>
      instance.__drainDueOnceForTesting({ now: CANCEL_TEST_AT + 2 }),
    );
    await first;
    const result = await runInDurableObject(stub, async (instance, state) => {
      const events = await instance.events(testTruthIdentity("trigger-redrive-cancel-propagates"));
      const observations = state.storage.sql
        .exec("SELECT mode, aborted FROM test_acquire_observations ORDER BY rowid")
        .toArray();
      return {
        cancel,
        second,
        done: events.filter((event) => event.kind === "test.redrive_cancelled.done").length,
        cancelled: events.filter((event) => event.kind === "test.redrive_cancelled.cancelled")
          .length,
        observations,
      };
    });

    expect(result).toEqual({
      cancel: { status: "requested", requested: 1 },
      second: { drained: 1 },
      done: 0,
      cancelled: 1,
      observations: [
        { mode: "normal", aborted: 0 },
        { mode: "redrive", aborted: 1 },
      ],
    });
  });

  it("uses the default acquire deadline when a trigger does not override it", async () => {
    const stub = testEnv.TRIGGER_CANCEL_DO.get(
      testEnv.TRIGGER_CANCEL_DO.idFromName("trigger-default-deadline"),
    );

    const result = await runInDurableObject(stub, async (instance, state) => {
      await instance.enqueueTrigger({
        triggerKind: "test.default_deadline",
        payload: { label: "five" },
        at: CANCEL_TEST_AT,
      });
      const drain = instance.__drainDueOnceForTesting({ now: CANCEL_TEST_AT });
      await scheduler.wait(5);
      const row = state.storage.sql
        .exec("SELECT claimed_at, claim_deadline_at FROM due_work")
        .toArray()[0];
      await drain;
      return Number(row?.claim_deadline_at) - Number(row?.claimed_at);
    });

    expect(result).toBe(60_000);
  });

  it("rejects unknown trigger cancellation without writing events due work or alarm", async () => {
    const stub = testEnv.TRIGGER_CANCEL_DO.get(
      testEnv.TRIGGER_CANCEL_DO.idFromName("trigger-cancel-unknown-kind"),
    );

    const result = await runInDurableObject(stub, async (instance, state) => {
      let tag: string | undefined;
      try {
        await instance.cancelTrigger({
          triggerKind: "missing.trigger",
          intentEventId: 1,
        });
      } catch (cause) {
        tag = (cause as { readonly _tag?: string })._tag;
      }
      const sql = state.storage.sql;
      const hasEventsTable =
        sql
          .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events'")
          .toArray().length > 0;
      const hasDueWorkTable =
        sql
          .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'due_work'")
          .toArray().length > 0;
      return {
        tag,
        events: hasEventsTable ? sql.exec("SELECT * FROM events").toArray().length : 0,
        due: hasDueWorkTable ? sql.exec("SELECT * FROM due_work").toArray().length : 0,
        alarm: await state.storage.getAlarm(),
      };
    });

    expect(result).toEqual({
      tag: "agent_os.unregistered_durable_trigger_kind",
      events: 0,
      due: 0,
      alarm: null,
    });
  });
});
