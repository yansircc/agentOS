import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "@effect/vitest";

import type { TriggerFacadeTestDO, TriggerTestingDrainTestDO } from "./test-worker";

interface TestEnv {
  readonly TRIGGER_FACADE_DO: DurableObjectNamespace<TriggerFacadeTestDO>;
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
