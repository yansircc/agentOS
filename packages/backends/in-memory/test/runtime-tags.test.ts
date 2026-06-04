import { Cause, Effect, Exit, Layer, ManagedRuntime, Option } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { bindingMaterialRef, materialRefKey } from "@agent-os/kernel/material-ref";
import {
  DurableTriggerCommitReturnedThenable,
  DurableTriggerDrainLimitExceeded,
  UnregisteredDurableTriggerKind,
} from "@agent-os/kernel/errors";
import {
  Admission,
  DURABLE_TRIGGER_SCHEDULED_REQUESTED,
  Dispatch,
  DurableTriggerRegistry,
  Ledger,
  Quota,
  Resources,
  Scheduler,
  TriggerPump,
  makeDurableTriggerRegistry,
  makeSchemaContract,
  scheduledEventTrigger,
  triggerParseFail,
  triggerParseOk,
  type DispatchReceiver,
  type DurableTrigger,
} from "@agent-os/runtime";
import type { LedgerEvent } from "@agent-os/kernel/types";
import {
  createInMemoryBackendState,
  createInMemoryRuntimeBackend,
  type InMemoryRuntimeLayerOptions,
} from "../src";
import { InMemoryTriggerPumpLive } from "../src/trigger-pump";

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

  it("TriggerPump.drainUntilQuiet drains trigger chains without caller-managed passes", async () => {
    interface ChainIntent {
      readonly step: number;
    }
    const chainTrigger = {
      kind: "test.chain",
      intentEventKind: "test.chain.requested",
      cancellation: "cooperative",
      parseIntent: (raw) =>
        typeof raw === "object" &&
        raw !== null &&
        typeof (raw as { readonly step?: unknown }).step === "number"
          ? triggerParseOk({ step: (raw as { readonly step: number }).step })
          : triggerParseFail("chain intent malformed"),
      acquire: (intent) => Effect.succeed(intent),
      commit: (intent, tx) => {
        tx.insertEvent({ kind: "test.chain.done", payload: { step: intent.step } });
        if (intent.step < 3) {
          tx.enqueue({
            triggerKind: "test.chain",
            intentEventKind: "test.chain.requested",
            payload: { step: intent.step + 1 },
            fireAt: tx.now,
          });
        }
      },
      commitCancelled: () => undefined,
    } satisfies DurableTrigger<ChainIntent, ChainIntent>;

    const { backend, runtime } = makeRuntime("chain-scope", { triggers: [chainTrigger] });
    try {
      const triggerPump = await runtime.runPromise(TriggerPump);
      const ledger = await runtime.runPromise(Ledger);
      const event = await runtime.runPromise(
        ledger.log("test.chain.requested", { step: 1 }, "chain-scope"),
      );
      backend.state.addDueWork("test.chain", event.id, 10);

      await expect(runtime.runPromise(triggerPump.drainDue(10))).resolves.toEqual({
        drained: 1,
      });
      expect(backend.state.duePending(10)).toHaveLength(1);

      await expect(runtime.runPromise(triggerPump.drainUntilQuiet(10))).resolves.toEqual({
        drained: 2,
        iterations: 3,
      });
      expect(backend.state.duePending(10)).toHaveLength(0);
      const events = await runtime.runPromise(ledger.events("chain-scope"));
      expect(
        events
          .filter((row) => row.kind === "test.chain.done")
          .map((row) => (row.payload as { readonly step: number }).step),
      ).toEqual([1, 2, 3]);
    } finally {
      await runtime.dispose();
    }
  });

  it.effect("TriggerPump.drainUntilQuiet fails typed when a trigger never reaches quiet", () =>
    Effect.gen(function* () {
      interface LoopIntent {
        readonly count: number;
      }
      const loopTrigger = {
        kind: "test.loop",
        intentEventKind: "test.loop.requested",
        cancellation: "cooperative",
        parseIntent: (raw) =>
          typeof raw === "object" &&
          raw !== null &&
          typeof (raw as { readonly count?: unknown }).count === "number"
            ? triggerParseOk({ count: (raw as { readonly count: number }).count })
            : triggerParseFail("loop intent malformed"),
        acquire: (intent) => Effect.succeed(intent),
        commit: (intent, tx) => {
          tx.insertEvent({ kind: "test.loop.done", payload: { count: intent.count } });
          tx.enqueue({
            triggerKind: "test.loop",
            intentEventKind: "test.loop.requested",
            payload: { count: intent.count + 1 },
            fireAt: tx.now,
          });
        },
        commitCancelled: () => undefined,
      } satisfies DurableTrigger<LoopIntent, LoopIntent>;

      const { backend, runtime } = makeRuntime("loop-scope", { triggers: [loopTrigger] });
      const ledger = yield* Effect.promise(() => runtime.runPromise(Ledger));
      const triggerPump = yield* Effect.promise(() => runtime.runPromise(TriggerPump));
      const event = yield* Effect.promise(() =>
        runtime.runPromise(ledger.log("test.loop.requested", { count: 1 }, "loop-scope")),
      );
      backend.state.addDueWork("test.loop", event.id, 10);

      const exit = yield* Effect.exit(triggerPump.drainUntilQuiet(10, { maxIterations: 2 }));

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(Option.isSome(failure)).toBe(true);
        if (Option.isSome(failure)) {
          expect(failure.value).toBeInstanceOf(DurableTriggerDrainLimitExceeded);
          expect((failure.value as DurableTriggerDrainLimitExceeded).drained).toBe(2);
        }
      }
      expect(backend.state.duePending(10)).toHaveLength(1);
      yield* Effect.promise(() => runtime.dispose());
    }),
  );

  it.effect("TriggerPump rejects thenable trigger commit and leaves due-work pending", () =>
    Effect.gen(function* () {
      interface ThenableIntent {
        readonly label: string;
      }
      const thenableTrigger = {
        kind: "test.thenable",
        intentEventKind: "test.thenable.requested",
        cancellation: "cooperative",
        parseIntent: (raw) =>
          typeof raw === "object" &&
          raw !== null &&
          typeof (raw as { readonly label?: unknown }).label === "string"
            ? triggerParseOk({ label: (raw as { readonly label: string }).label })
            : triggerParseFail("thenable intent malformed"),
        acquire: (intent) => Effect.succeed(intent),
        commit: ((intent, tx) => {
          tx.insertEvent({ kind: "test.thenable.done", payload: intent });
          return Promise.resolve(undefined);
        }) as DurableTrigger<ThenableIntent, ThenableIntent>["commit"],
        commitCancelled: () => undefined,
      } satisfies DurableTrigger<ThenableIntent, ThenableIntent>;

      const { backend, runtime } = makeRuntime("thenable-scope", {
        triggers: [thenableTrigger],
      });
      const ledger = yield* Effect.promise(() => runtime.runPromise(Ledger));
      const triggerPump = yield* Effect.promise(() => runtime.runPromise(TriggerPump));
      const event = yield* Effect.promise(() =>
        runtime.runPromise(
          ledger.log("test.thenable.requested", { label: "one" }, "thenable-scope"),
        ),
      );
      backend.state.addDueWork("test.thenable", event.id, 10);

      const exit = yield* Effect.exit(triggerPump.drainDue(10));

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(Option.isSome(failure)).toBe(true);
        if (Option.isSome(failure)) {
          expect(failure.value).toBeInstanceOf(DurableTriggerCommitReturnedThenable);
        }
      }
      expect(backend.state.duePending(10)).toHaveLength(1);
      const events = yield* ledger.events("thenable-scope");
      expect(events.filter((row) => row.kind === "test.thenable.done")).toHaveLength(0);
      yield* Effect.promise(() => runtime.dispose());
    }),
  );

  it("SchedulerLive fires due events exactly once", async () => {
    const { runtime } = makeRuntime("schedule-scope");
    try {
      const scheduler = await runtime.runPromise(Scheduler);
      const triggerPump = await runtime.runPromise(TriggerPump);
      const ledger = await runtime.runPromise(Ledger);
      await runtime.runPromise(scheduler.schedule(10, "example.due", { id: "job-1" }));

      await expect(runtime.runPromise(triggerPump.drainDue(9))).resolves.toEqual({
        drained: 0,
      });
      await expect(runtime.runPromise(triggerPump.drainDue(10))).resolves.toEqual({
        drained: 1,
      });
      await expect(runtime.runPromise(triggerPump.drainDue(10))).resolves.toEqual({
        drained: 0,
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

  it.effect("empty trigger registry fails closed and leaves due-work pending", () =>
    Effect.gen(function* () {
      const state = createInMemoryBackendState();
      const runtime = ManagedRuntime.make(
        InMemoryTriggerPumpLive(state, "empty-registry").pipe(
          Layer.provide(Layer.succeed(DurableTriggerRegistry, new Map())),
        ),
      );
      const [event] = yield* state.commitEvents([
        {
          ts: 10,
          kind: "unknown.trigger.requested",
          scope: "empty-registry",
          payload: { ok: true },
        },
      ]);
      state.addDueWork("unknown.trigger", event!.id, 10);
      const triggerPump = yield* Effect.promise(() => runtime.runPromise(TriggerPump));

      const exit = yield* Effect.exit(triggerPump.drainDue(10));

      expect(Exit.isFailure(exit)).toBe(true);
      expect(state.duePending(10)).toHaveLength(1);
      yield* Effect.promise(() => runtime.dispose());
    }),
  );

  it.effect("unregistered trigger submit writes no event or due work", () =>
    Effect.gen(function* () {
      const state = createInMemoryBackendState();
      const registry = yield* makeDurableTriggerRegistry([scheduledEventTrigger]);

      const exit = yield* Effect.exit(
        state.commitTriggerIntent("submit-scope", 10, registry, "missing.trigger", () => {
          throw new Error("makeSpec should not run");
        }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(Option.isSome(failure)).toBe(true);
        if (Option.isSome(failure)) {
          expect(failure.value).toBeInstanceOf(UnregisteredDurableTriggerKind);
          expect((failure.value as UnregisteredDurableTriggerKind).kind).toBe("missing.trigger");
        }
      }
      expect(state.snapshot("submit-scope")).toHaveLength(0);
      expect(state.duePending(10)).toHaveLength(0);
    }),
  );

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
        runtime.runPromise(quota.tryGrant("quota-scope", "tool-a", 1, 60_000, 1, "tool-a", "op-1")),
      ).resolves.toMatchObject({ granted: true, consumed: 0, limit: 1 });
      await expect(
        runtime.runPromise(quota.tryGrant("quota-scope", "tool-a", 1, 60_000, 1, "tool-a", "op-2")),
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
            payload: { key: "tool-a", amount: "x", toolName: "tool-a", operationRef: "bad-op" },
          },
        ]),
      );
      const exit = await runtime.runPromiseExit(
        quota.tryGrant("quota-scope", "tool-a", 1, Number.POSITIVE_INFINITY, 10, "tool-a", "op-3"),
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
