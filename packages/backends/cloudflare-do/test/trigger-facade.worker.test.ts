import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";

import type {
  TriggerBoundaryTestDO,
  TriggerFacadeTestDO,
  TriggerFactoryErrorTestDO,
  TriggerTestingDrainTestDO,
} from "./test-worker";

interface TestEnv {
  readonly TRIGGER_FACADE_DO: DurableObjectNamespace<TriggerFacadeTestDO>;
  readonly TRIGGER_FACTORY_ERROR_DO: DurableObjectNamespace<TriggerFactoryErrorTestDO>;
  readonly TRIGGER_BOUNDARY_DO: DurableObjectNamespace<TriggerBoundaryTestDO>;
  readonly TRIGGER_TESTING_DRAIN_DO: DurableObjectNamespace<TriggerTestingDrainTestDO>;
}

const testEnv = env as unknown as TestEnv;

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

    const events = await stub.events();
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
      return instance.events();
    });

    expect(events.filter((event) => event.kind === "test.fold.requested")).toHaveLength(2);
    expect(
      events.filter((event) => event.kind === "test.fold.done").map((event) => event.payload),
    ).toEqual([
      { label: "one", seen: 0 },
      { label: "two", seen: 1 },
    ]);
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
      const events = await instance.events();
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
});
