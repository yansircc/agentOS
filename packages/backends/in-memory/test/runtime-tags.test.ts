import { Cause, Effect, Exit, ManagedRuntime, Option } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { bindingMaterialRef, materialRefKey } from "@agent-os/kernel/material-ref";
import { DURABLE_TRIGGER_SCHEDULED_REQUESTED } from "@agent-os/backend-protocol";
import {
  Admission,
  Dispatch,
  Ledger,
  Quota,
  Resources,
  Scheduler,
  makeSchemaContract,
  type DispatchReceiver,
} from "@agent-os/runtime";
import type { LedgerEvent } from "@agent-os/kernel/types";
import {
  createInMemoryBackendState,
  createInMemoryRuntimeBackend,
  type InMemoryRuntimeLayerOptions,
} from "../src";

const response = (text: string) => ({
  text,
  toolCalls: [],
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
});

const makeRuntime = (scope: string, options: Omit<InMemoryRuntimeLayerOptions, "scope"> = {}) => {
  const backend = createInMemoryRuntimeBackend({ ...options, scope });
  const runtime = ManagedRuntime.make(backend.layer);
  return { backend, runtime };
};

describe("in-memory runtime backend", () => {
  it("LedgerLive persists facts and fans out after commit", async () => {
    const { backend, runtime } = makeRuntime("ledger-scope");
    const fired: string[] = [];
    backend.state.subscribe({
      sink: (event) => fired.push(`${event.id}:${event.kind}`),
    });

    try {
      const ledger = await runtime.runPromise(Ledger);
      const event = await runtime.runPromise(
        ledger.log("example.recorded", { ok: true }, "ledger-scope"),
      );
      const events = await runtime.runPromise(ledger.events("ledger-scope"));

      expect(event.id).toBe(1);
      expect(events.map((row) => row.kind)).toEqual(["example.recorded"]);
      expect(fired).toEqual(["1:example.recorded"]);
    } finally {
      await runtime.dispose();
    }
  });

  it("SchedulerLive fires due events exactly once", async () => {
    const { runtime } = makeRuntime("schedule-scope");
    try {
      const scheduler = await runtime.runPromise(Scheduler);
      const ledger = await runtime.runPromise(Ledger);
      await runtime.runPromise(scheduler.schedule(10, "example.due", { id: "job-1" }));

      await expect(runtime.runPromise(scheduler.fireDue(9))).resolves.toEqual({
        fired: 0,
      });
      await expect(runtime.runPromise(scheduler.fireDue(10))).resolves.toEqual({
        fired: 1,
      });
      await expect(runtime.runPromise(scheduler.fireDue(10))).resolves.toEqual({
        fired: 0,
      });
      const events = await runtime.runPromise(ledger.events("schedule-scope"));
      expect(events.map((event) => event.kind)).toEqual([
        DURABLE_TRIGGER_SCHEDULED_REQUESTED,
        "example.due",
      ]);
    } finally {
      await runtime.dispose();
    }
  });

  it("DispatchLive dedupes receiver inbound delivery by source scope and idempotency key", async () => {
    const state = createInMemoryBackendState();
    const bindingRef = bindingMaterialRef({
      provider: "test",
      bindingKind: "do",
      ref: "receiver",
    });
    const bindingKey = materialRefKey(bindingRef);
    const receiverRuntime = ManagedRuntime.make(
      createInMemoryRuntimeBackend({ state, scope: "receiver" }).layer,
    );
    const receiver: DispatchReceiver = {
      __agentosReceiveDispatch: (envelope) =>
        receiverRuntime.runPromise(
          Effect.gen(function* () {
            const dispatch = yield* Dispatch;
            return yield* dispatch.receive(envelope);
          }),
        ),
    };
    const senderRuntime = ManagedRuntime.make(
      createInMemoryRuntimeBackend({
        state,
        scope: "sender",
        dispatchTargets: {
          [bindingKey]: {
            deliver: (envelope) => receiver.__agentosReceiveDispatch(envelope),
          },
        },
      }).layer,
    );

    try {
      const senderDispatch = await senderRuntime.runPromise(Dispatch);
      const senderLedger = await senderRuntime.runPromise(Ledger);
      const spec = {
        target: {
          bindingRef,
          scope: "receiver",
          scopeRef: { kind: "conversation" as const, scopeId: "receiver" },
        },
        event: "app.received",
        data: { value: 1 },
        idempotencyKey: "same-key",
      };

      await senderRuntime.runPromise(senderDispatch.dispatchToScope(spec));
      await senderRuntime.runPromise(senderDispatch.dispatchToScope(spec));

      const receiverEvents = await senderRuntime.runPromise(senderLedger.events("receiver"));
      expect(receiverEvents.map((event) => event.kind)).toEqual([
        "dispatch.inbound.accepted",
        "app.received",
      ]);
      const senderEvents = await senderRuntime.runPromise(senderLedger.events("sender"));
      expect(
        senderEvents.filter((event) => event.kind === "dispatch.outbound.requested"),
      ).toHaveLength(2);
      expect(
        senderEvents.filter((event) => event.kind === "dispatch.outbound.delivered"),
      ).toHaveLength(2);
    } finally {
      await senderRuntime.dispose();
      await receiverRuntime.dispose();
    }
  });

  it("ResourcesLive derives reservations from ledger facts", async () => {
    const { runtime } = makeRuntime("resource-scope");
    try {
      const resources = await runtime.runPromise(Resources);
      await runtime.runPromise(
        resources.grant("resource-scope", { key: "credit", amount: 5, ref: "seed" }),
      );
      const first = await runtime.runPromise(
        resources.reserve("resource-scope", {
          key: "credit",
          amount: 2,
          ref: "req-1",
          idempotencyKey: "reserve-1",
        }),
      );
      const second = await runtime.runPromise(
        resources.reserve("resource-scope", {
          key: "credit",
          amount: 2,
          ref: "req-1-retry",
          idempotencyKey: "reserve-1",
        }),
      );
      expect(second.reservationId).toBe(first.reservationId);
      await expect(
        runtime.runPromise(resources.project("resource-scope", "credit")),
      ).resolves.toEqual({
        available: 3,
        reserved: 2,
        consumed: 0,
      });
    } finally {
      await runtime.dispose();
    }
  });

  it("QuotaLive writes consumed/rate_limited facts and fails fast on malformed prior facts", async () => {
    const { backend, runtime } = makeRuntime("quota-scope");
    try {
      const quota = await runtime.runPromise(Quota);
      const ledger = await runtime.runPromise(Ledger);
      await expect(
        runtime.runPromise(quota.tryGrant("quota-scope", "tool-a", 1, 60_000, 1, "tool-a")),
      ).resolves.toMatchObject({ granted: true, consumed: 0, limit: 1 });
      await expect(
        runtime.runPromise(quota.tryGrant("quota-scope", "tool-a", 1, 60_000, 1, "tool-a")),
      ).resolves.toMatchObject({ granted: false, consumed: 1, limit: 1 });
      const events = await runtime.runPromise(ledger.events("quota-scope"));
      expect(events.map((event) => event.kind)).toEqual([
        "dispatch.consumed",
        "dispatch.rate_limited",
      ]);

      await runtime.runPromise(
        backend.state.commitEvents([
          {
            kind: "dispatch.consumed",
            scope: "quota-scope",
            payload: { key: "tool-a", amount: "x", toolName: "tool-a" },
          },
        ]),
      );
      const exit = await runtime.runPromiseExit(
        quota.tryGrant("quota-scope", "tool-a", 1, Number.POSITIVE_INFINITY, 10, "tool-a"),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(Option.isSome(failure)).toBe(true);
        if (Option.isSome(failure)) {
          expect(failure.value._tag).toBe("agent_os.sql_error");
        }
      }
    } finally {
      await runtime.dispose();
    }
  });

  it("AdmissionLive uses injected LlmTransport and commits evidence plus delivered payload", async () => {
    const { runtime } = makeRuntime("admission-scope", {
      llm: { responses: [response(JSON.stringify({ answer: "ok" }))] },
    });
    try {
      const admission = await runtime.runPromise(Admission);
      const ledger = await runtime.runPromise(Ledger);
      const schemaContract = await runtime.runPromise(
        makeSchemaContract({
          type: "object",
          properties: { answer: { type: "string" } },
          required: ["answer"],
          additionalProperties: false,
        }),
      );
      const result = await runtime.runPromise(
        admission.attemptStructured<{ readonly answer: string }>({
          scope: "admission-scope",
          route: { kind: "cf-ai-binding", modelId: "@cf/test" },
          schemaContract,
          strategy: "forced-tool-call",
          stimulus: {
            kind: "live",
            userInput: { userText: "answer" },
            deliver: (decoded) => ({ event: "app.structured", payload: decoded }),
          },
        }),
      );

      expect(result.ok).toBe(true);
      const events = await runtime.runPromise(ledger.events("admission-scope"));
      expect(events.map((event: LedgerEvent) => event.kind)).toEqual([
        "llm.structured.evidence",
        "app.structured",
      ]);
    } finally {
      await runtime.dispose();
    }
  });
});
