/**
 * emitEvent — deterministic contract test.
 *
 * Exercises AgentDOBase's now-write primitive (the corner of the reactive
 * surface that submit and scheduleEvent do NOT cover).
 *
 * Two access patterns are exercised, by design:
 *
 *   1. **Stub RPC** (stub.emitEvent / stub.events) — validates the full
 *      production path including DO RPC serialization. Used for success
 *      and reactive-chain assertions where return values flow naturally.
 *
 *   2. **runInDurableObject** (instance.emitEvent) — validates failure
 *      paths where the rejected error's identity matters. DO RPC erases
 *      Error subclass identity (name resets to "Error", custom fields
 *      stripped); calling the method on the in-process instance
 *      preserves the TaggedError shape (`_tag` field accessible).
 *
 * No LLM involved — emitEvent doesn't touch the AiBinding service.
 */

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import type { LedgerEventRpc } from "../src";
import type { EmitTestDO } from "./test-worker";

interface TestEnv {
  readonly EMIT_DO: DurableObjectNamespace<EmitTestDO>;
}

const testEnv = env as unknown as TestEnv;

describe("emitEvent — substrate now-write primitive", () => {
  it("commits ledger row AND fires on() handler chain (interview.answer → interview.followup)", async () => {
    const scope = "emit-chain-1";
    const stub = testEnv.EMIT_DO.get(testEnv.EMIT_DO.idFromName(scope));

    const result: { id: number } = await stub.emitEvent({
      event: "interview.answer",
      data: { questionId: "q1", text: "blue" },
    });
    expect(result.id).toBeGreaterThanOrEqual(1);

    // Reactive chain runs synchronously inside emitEvent (EventBus.fire is
    // awaited before Ledger.log resolves). After the await above, both
    // the source row and the handler-emitted followup MUST be in the
    // ledger already.
    const events: LedgerEventRpc[] = await stub.events();

    const answers = events.filter((e) => e.kind === "interview.answer");
    const followups = events.filter((e) => e.kind === "interview.followup");

    expect(answers).toHaveLength(1);
    expect(followups).toHaveLength(1);

    expect(answers[0]?.payload).toEqual({ questionId: "q1", text: "blue" });

    // Handler captured source event id + payload — proves the EventBus
    // delivers the full LedgerEventRpc, not just a kind notification.
    expect(followups[0]?.payload).toEqual({
      sourceId: answers[0]?.id,
      sourcePayload: { questionId: "q1", text: "blue" },
    });
  });

  it("rejects reserved event kinds with ReservedEventKindError", async () => {
    const scope = "emit-reserved-1";
    const stub = testEnv.EMIT_DO.get(testEnv.EMIT_DO.idFromName(scope));

    // Any prefix from CORE_RESERVED_PREFIXES — pick one per category to
    // confirm the namespace guard is shared with submit / scheduleEvent.
    const reserved = [
      "agent.aborted.app_test",
      "chat.ingested",
      "dispatch.consumed",
      "llm.response",
      "tool.executed",
      "quota.exceeded",
      "resource.granted",
    ];

    await runInDurableObject(stub, async (instance) => {
      for (const event of reserved) {
        let caught: { _tag?: string; event?: string } | undefined = undefined;
        try {
          await instance.emitEvent({ event, data: {} });
        } catch (e) {
          caught = e as { _tag?: string; event?: string };
        }
        expect(caught, `should reject reserved kind: ${event}`).toBeDefined();
        // In-process access — full TaggedError instance survives.
        expect(caught?._tag).toBe("agent_os.reserved_event_kind");
        expect(caught?.event).toBe(event);
      }
    });

    // After all reserved attempts, ledger MUST be empty — emitEvent
    // rejected before any row was written. (Read via stub to validate the
    // ledger is also empty from the outside, not just inside.)
    const events: LedgerEventRpc[] = await stub.events();
    expect(events).toHaveLength(0);
  });

  it("rejects unnamed DOs (newUniqueId) with ScopeMissingError", async () => {
    const id = testEnv.EMIT_DO.newUniqueId();
    const stub = testEnv.EMIT_DO.get(id);

    await runInDurableObject(stub, async (instance) => {
      let caught: { _tag?: string } | undefined = undefined;
      try {
        await instance.emitEvent({ event: "interview.answer", data: {} });
      } catch (e) {
        caught = e as { _tag?: string };
      }
      expect(caught).toBeDefined();
      expect(caught?._tag).toBe("agent_os.scope_missing");
    });
  });

  it("preserves scope SSoT — each DO instance writes only into its own scope", async () => {
    const scopeA = "emit-isolation-A";
    const scopeB = "emit-isolation-B";
    const stubA = testEnv.EMIT_DO.get(testEnv.EMIT_DO.idFromName(scopeA));
    const stubB = testEnv.EMIT_DO.get(testEnv.EMIT_DO.idFromName(scopeB));

    await stubA.emitEvent({ event: "interview.answer", data: { x: "A" } });
    await stubB.emitEvent({ event: "interview.answer", data: { x: "B" } });

    const eventsA: LedgerEventRpc[] = await stubA.events();
    const eventsB: LedgerEventRpc[] = await stubB.events();

    // Each scope sees its own answer + the handler-chained followup.
    expect(eventsA.every((e) => e.scope === scopeA)).toBe(true);
    expect(eventsB.every((e) => e.scope === scopeB)).toBe(true);

    // Inner DO instances did NOT cross-contaminate via the bus.
    // Use runInDurableObject to inspect raw storage directly — the DOs
    // are distinct SQLite databases by construction.
    await runInDurableObject(stubA, async (_inst, state) => {
      const rows = state.storage.sql
        .exec("SELECT scope FROM events")
        .toArray();
      expect(rows.every((r) => r.scope === scopeA)).toBe(true);
    });
  });
});
