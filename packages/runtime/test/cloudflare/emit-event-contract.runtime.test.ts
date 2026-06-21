/**
 * emitEvent — deterministic contract test.
 *
 * Exercises the configured DO now-write primitive (the corner of the reactive
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
 * No LLM involved — emitEvent doesn't touch the LlmTransport service.
 */

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";

import type { LedgerEventRpc } from "@agent-os/core/types";
import type { EmitTestDO, ExtensionTestDO } from "./test-worker";
import { testTruthIdentity } from "./_identity";
import { sqlText } from "../../src/cloudflare/storage/sql-row";

interface TestEnv {
  readonly EMIT_DO: DurableObjectNamespace<EmitTestDO>;
  readonly EXTENSION_DO: DurableObjectNamespace<ExtensionTestDO>;
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
    const events: LedgerEventRpc[] = await stub.events(testTruthIdentity(scope));

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

  it("rejects claimed event kinds with CapabilityRejected", async () => {
    const scope = "emit-claimed-1";
    const stub = testEnv.EMIT_DO.get(testEnv.EMIT_DO.idFromName(scope));

    // Any substrate-owned prefix must be unavailable to cap_app writes.
    const claimed = [
      "agent.aborted.app_test",
      "chat.ingested",
      "quota.consumed",
      "llm.response",
      "tool.executed",
      "runtime.completed_after_tools",
      "quota.exceeded",
      "resource_pool.granted",
    ];

    await runInDurableObject(stub, async (instance) => {
      for (const event of claimed) {
        let caught: { _tag?: string; event?: string } | undefined = undefined;
        try {
          await instance.emitEvent({ event, data: {} });
        } catch (e) {
          caught = e as { _tag?: string; event?: string };
        }
        expect(caught, `should reject claimed kind: ${event}`).toBeDefined();
        // In-process access — full TaggedError instance survives.
        expect(caught?._tag).toBe("agent_os.capability_rejected");
        expect(caught?.event).toBe(event);
      }
    });

    // After all claimed attempts, ledger MUST be empty — emitEvent
    // rejected before any row was written. (Read via stub to validate the
    // ledger is also empty from the outside, not just inside.)
    const events: LedgerEventRpc[] = await stub.events(testTruthIdentity(scope));
    expect(events).toHaveLength(0);
  });

  it("rejects extension-owned event kinds only when the DO registers that extension", async () => {
    const defaultStub = testEnv.EMIT_DO.get(testEnv.EMIT_DO.idFromName("emit-image-app-fact"));
    await defaultStub.emitEvent({
      event: "image.job.requested",
      data: { appOwned: true },
    });
    await expect(
      defaultStub.events(testTruthIdentity("emit-image-app-fact")),
    ).resolves.toHaveLength(1);

    const extensionStub = testEnv.EXTENSION_DO.get(
      testEnv.EXTENSION_DO.idFromName("emit-image-extension-owned"),
    );
    await runInDurableObject(extensionStub, async (instance) => {
      let caught: { _tag?: string; event?: string } | undefined;
      try {
        await instance.emitEvent({
          event: "image.job.requested",
          data: { appOwned: false },
        });
      } catch (e) {
        caught = e as { _tag?: string; event?: string };
      }
      expect(caught?._tag).toBe("agent_os.capability_rejected");
      expect(caught?.event).toBe("image.job.requested");
    });
    await expect(
      extensionStub.events(testTruthIdentity("emit-image-extension-owned")),
    ).resolves.toHaveLength(0);
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

    const eventsA: LedgerEventRpc[] = await stubA.events(testTruthIdentity(scopeA));
    const eventsB: LedgerEventRpc[] = await stubB.events(testTruthIdentity(scopeB));

    // Each scope sees its own answer + the handler-chained followup.
    expect(eventsA.every((e) => e.scopeRef.scopeId === scopeA)).toBe(true);
    expect(eventsB.every((e) => e.scopeRef.scopeId === scopeB)).toBe(true);

    // Inner DO instances did NOT cross-contaminate via the bus.
    // Use runInDurableObject to inspect raw storage directly — the DOs
    // are distinct SQLite databases by construction.
    await runInDurableObject(stubA, async (_inst, state) => {
      const rows = state.storage.sql.exec("SELECT scope_ref FROM events").toArray();
      expect(
        rows.every((r) => JSON.parse(sqlText(r.scope_ref, "events.scope_ref")).scopeId === scopeA),
      ).toBe(true);
    });
  });
});
