import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "@effect/vitest";

import type { TriggerFacadeTestDO } from "./test-worker";

interface TestEnv {
  readonly TRIGGER_FACADE_DO: DurableObjectNamespace<TriggerFacadeTestDO>;
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
});
