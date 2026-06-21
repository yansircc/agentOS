import { Cause, Effect, Exit, Layer, ManagedRuntime, Option, Schema } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { bindingMaterialRef, materialRefKey } from "@agent-os/core/material-ref";
import {
  DURABLE_TRIGGER_SCHEDULED_REQUESTED,
  dispatchTargetDelivered,
  type DispatchReceiver,
} from "@agent-os/core/backend-protocol";
import {
  DurableTriggerCommitReturnedThenable,
  DurableTriggerDrainLimitExceeded,
  UnregisteredDurableTriggerKind,
} from "@agent-os/core/errors";
import {
  Admission,
  Dispatch,
  DurableTriggerRegistry,
  Ledger,
  Quota,
  Resources,
  Scheduler,
  TriggerPump,
  makeDurableTriggerRegistry,
  scheduledEventTrigger,
  triggerParseFail,
  triggerParseOk,
  type DurableTrigger,
} from "@agent-os/runtime";
import {
  agentRunInterruptedEvent,
  agentRunResumedEvent,
  agentRunStartedEvent,
  makeAdmissionSchemaSpec,
  runtimeHistoryCompactedEvent,
} from "@agent-os/core/runtime-protocol";
import type { LedgerEvent } from "@agent-os/core/types";
import {
  createInMemoryBackendState,
  createInMemoryRuntimeBackend,
  type InMemoryRuntimeLayerOptions,
} from "../src";
import { InMemoryTriggerPumpLive } from "../src/trigger-pump";
import { truthIdentity, runtimeEventIdentity } from "./identity";

const structuredResponse = (args: Record<string, unknown>) => ({
  items: [
    {
      type: "tool_call" as const,
      call: {
        id: "structured-call",
        type: "function" as const,
        function: { name: "_submit_structured", arguments: JSON.stringify(args) },
      },
    },
  ],
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
});

const DECISION_GATE_FACT_OWNER = "@agent-os/decision-gate";

const makeRuntime = (
  scope: string,
  options: Omit<InMemoryRuntimeLayerOptions, "identity" | "scope"> = {},
) => {
  const backend = createInMemoryRuntimeBackend({ ...options, identity: truthIdentity(scope) });
  const runtime = ManagedRuntime.make(backend.layer);
  return { backend, runtime };
};

const invalidRuntimeCompactionContent = (scope: string) => {
  const spec = runtimeHistoryCompactedEvent({
    ...truthIdentity(scope),
    runId: 1,
    turn: { id: 1, index: 0 },
    sourceEventId: 1,
    toolCallId: "call-1",
    toolName: "lookup",
    originalBytes: 256,
    compactedBytes: 16,
  });
  return { kind: spec.kind, payload: spec.payload };
};

const rawCanonicalPayload = () => {
  const payload = {
    visible: "raw",
    toJSON: () => ({ visible: "stored" }),
  };
  Object.defineProperty(payload, "secret", {
    value: "not-recorded",
    enumerable: false,
  });
  return payload;
};

const payloadObservation = (payload: unknown) => ({
  visible:
    typeof payload === "object" && payload !== null
      ? (payload as { readonly visible?: unknown }).visible
      : undefined,
  hasSecret: typeof payload === "object" && payload !== null && "secret" in payload,
});

const expectSqlErrorFailure = (exit: Exit.Exit<unknown, unknown>): void => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    const failure = Cause.findErrorOption(exit.cause);
    expect(Option.isSome(failure)).toBe(true);
    if (Option.isSome(failure)) {
      expect(failure.value).toMatchObject({ _tag: "agent_os.sql_error" });
    }
  }
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
      const [event] = await runtime.runPromise(
        ledger.commit([
          { kind: "example.recorded", payload: { ok: true }, ...truthIdentity("ledger-scope") },
        ]),
      );
      const events = await runtime.runPromise(ledger.events(truthIdentity("ledger-scope")));

      expect(event?.id).toBe(1);
      expect(events.map((row) => row.kind)).toEqual(["example.recorded"]);
      expect(fired).toEqual(["1:example.recorded"]);
    } finally {
      await runtime.dispose();
    }
  });

  it("LedgerLive rejects invalid runtime transitions before append", async () => {
    const { runtime } = makeRuntime("runtime-l0-scope");
    try {
      const ledger = await runtime.runPromise(Ledger);

      const exit = await runtime.runPromiseExit(
        ledger.commit([
          runtimeHistoryCompactedEvent({
            ...truthIdentity("runtime-l0-scope"),
            runId: 1,
            turn: { id: 1, index: 0 },
            sourceEventId: 1,
            toolCallId: "call-1",
            toolName: "lookup",
            originalBytes: 256,
            compactedBytes: 16,
          }),
        ]),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure)).toBe(true);
        if (Option.isSome(failure)) {
          expect(failure.value).toMatchObject({ _tag: "agent_os.runtime_storage_error" });
        }
      }
      const events = await runtime.runPromise(ledger.events(truthIdentity("runtime-l0-scope")));
      expect(events).toEqual([]);
    } finally {
      await runtime.dispose();
    }
  });

  it.effect("runtime L0 can prove resume against prior carrier-owned consumed facts", () =>
    Effect.gen(function* () {
      const scope = "resume-carrier-l0";
      const state = createInMemoryBackendState();
      const [started, interrupted] = yield* state.commitProtocolEvents([
        {
          ts: 10,
          ...runtimeEventIdentity(scope),
          ...agentRunStartedEvent({ ...truthIdentity(scope), intent: "answer" }),
        },
        {
          ts: 11,
          ...runtimeEventIdentity(scope),
          ...agentRunInterruptedEvent({
            ...truthIdentity(scope),
            runId: 1,
            turn: { id: 1, index: 0 },
            interruptId: "interrupt-1",
            reason: "decision_required",
            resumeSchema: { type: "object" },
            tokensUsed: 1,
            decision: {
              gateRef: "gate:1",
              subjectRef: "tool:lookup",
              toolCallId: "call-1",
              toolName: "lookup",
            },
          }),
        },
      ]);
      const [consumed] = yield* state.commitProtocolEvents([
        {
          ts: 12,
          kind: "decision_gate.consumed",
          ...truthIdentity(scope),
          factOwnerRef: DECISION_GATE_FACT_OWNER,
          payload: {
            gateRef: "gate:1",
            decisionRef: "decision:1",
            consumedBy: "runtime",
            claim: { phase: "lived" },
          },
        },
      ]);
      const resumed = agentRunResumedEvent({
        ...truthIdentity(scope),
        runId: started!.id,
        turn: { id: started!.id, index: 0 },
        interruptId: "interrupt-1",
        resume: { kind: "approval", approved: true },
        resumedAtEventId: consumed!.id,
      });

      yield* state.commitProtocolEvents([
        {
          ts: 20,
          kind: resumed.kind,
          ...runtimeEventIdentity(scope),
          payload: resumed.payload,
        },
      ]);

      expect(state.snapshot(truthIdentity(scope)).map((event) => event.kind)).toEqual([
        "agent.run.started",
        "agent.run.interrupted",
        "decision_gate.consumed",
        "agent.run.resumed",
      ]);
      expect(interrupted?.payload).toMatchObject({
        decision: { gateRef: "gate:1" },
      });
    }),
  );

  it.effect("direct state append paths reject invalid runtime transitions before mutation", () =>
    Effect.gen(function* () {
      const registry = yield* makeDurableTriggerRegistry([scheduledEventTrigger]);

      const intentScope = "trigger-intent-l0";
      const intentState = createInMemoryBackendState();
      const triggerIntentExit = yield* Effect.exit(
        intentState.commitTriggerIntent(
          runtimeEventIdentity(intentScope),
          10,
          registry,
          scheduledEventTrigger.kind,
          () => invalidRuntimeCompactionContent(intentScope),
        ),
      );
      expectSqlErrorFailure(triggerIntentExit);
      expect(intentState.snapshot(truthIdentity(intentScope))).toEqual([]);
      expect(intentState.duePending(runtimeEventIdentity(intentScope), 10)).toEqual([]);

      const attachedScope = "attached-stream-l0";
      const attachedState = createInMemoryBackendState();
      const attachedExit = yield* Effect.exit(
        attachedState.commitAttachedStreamTerminal(
          runtimeEventIdentity(attachedScope),
          attachedScope,
          "stream:1",
          "test.stream",
          10,
          new AbortController().signal,
          { kind: "completed", terminal: { ok: true } },
          (_terminal, tx) => {
            tx.insertEvent(invalidRuntimeCompactionContent(attachedScope));
            return null;
          },
        ),
      );
      expectSqlErrorFailure(attachedExit);
      expect(attachedState.snapshot(truthIdentity(attachedScope))).toEqual([]);

      const triggerScope = "trigger-commit-l0";
      const triggerState = createInMemoryBackendState();
      triggerState.addDueWork(runtimeEventIdentity(triggerScope), "test.trigger", 1, 10);
      const due = triggerState.duePending(runtimeEventIdentity(triggerScope), 10)[0];
      expect(due).toBeDefined();
      if (due === undefined) return;
      const triggerExit = yield* Effect.exit(
        triggerState.commitTrigger(
          triggerScope,
          due,
          10,
          () => true,
          (tx) => {
            tx.insertEvent(invalidRuntimeCompactionContent(triggerScope));
            return null;
          },
        ),
      );
      expectSqlErrorFailure(triggerExit);
      expect(triggerState.snapshot(truthIdentity(triggerScope))).toEqual([]);
      expect(triggerState.duePending(runtimeEventIdentity(triggerScope), 10)).toHaveLength(1);
    }),
  );

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
      const [event] = await runtime.runPromise(
        ledger.commit([
          {
            kind: "test.chain.requested",
            payload: { step: 1 },
            ...truthIdentity("chain-scope"),
          },
        ]),
      );
      backend.state.addDueWork(runtimeEventIdentity("chain-scope"), "test.chain", event!.id, 10);

      await expect(runtime.runPromise(triggerPump.drainDue(10))).resolves.toEqual({
        drained: 1,
      });
      expect(backend.state.duePending(runtimeEventIdentity("chain-scope"), 10)).toHaveLength(1);

      await expect(runtime.runPromise(triggerPump.drainUntilQuiet(10))).resolves.toEqual({
        drained: 2,
        iterations: 3,
      });
      expect(backend.state.duePending(runtimeEventIdentity("chain-scope"), 10)).toHaveLength(0);
      const events = await runtime.runPromise(ledger.events(truthIdentity("chain-scope")));
      expect(
        events
          .filter((row) => row.kind === "test.chain.done")
          .map((row) => (row.payload as { readonly step: number }).step),
      ).toEqual([1, 2, 3]);
    } finally {
      await runtime.dispose();
    }
  });

  it("exposes canonical payloads through trigger tx append results", async () => {
    interface CanonicalIntent {
      readonly id: string;
    }
    let observed:
      | {
          readonly inserted: ReturnType<typeof payloadObservation>;
          readonly enqueued: ReturnType<typeof payloadObservation>;
        }
      | undefined;
    const canonicalTrigger = {
      kind: "test.trigger_canonical_tx",
      intentEventKind: "test.trigger_canonical_tx.requested",
      cancellation: "cooperative",
      parseIntent: (raw) =>
        typeof raw === "object" &&
        raw !== null &&
        typeof (raw as { readonly id?: unknown }).id === "string"
          ? triggerParseOk({ id: (raw as { readonly id: string }).id })
          : triggerParseFail("canonical intent malformed"),
      acquire: (intent) => Effect.succeed(intent),
      commit: (_intent, tx) => {
        const inserted = tx.insertEvent({
          kind: "test.trigger_canonical_tx.done",
          payload: rawCanonicalPayload(),
        });
        const enqueued = tx.enqueue({
          triggerKind: "test.trigger_canonical_tx",
          intentEventKind: "test.trigger_canonical_tx.requested",
          payload: rawCanonicalPayload(),
          fireAt: tx.now + 1000,
        });
        observed = {
          inserted: payloadObservation(inserted.payload),
          enqueued: payloadObservation(enqueued.payload),
        };
      },
      commitCancelled: () => undefined,
    } satisfies DurableTrigger<CanonicalIntent, CanonicalIntent>;

    const { backend, runtime } = makeRuntime("trigger-canonical-tx", {
      triggers: [canonicalTrigger],
    });
    try {
      const triggerPump = await runtime.runPromise(TriggerPump);
      const ledger = await runtime.runPromise(Ledger);
      const [event] = await runtime.runPromise(
        ledger.commit([
          {
            kind: "test.trigger_canonical_tx.requested",
            payload: { id: "intent-1" },
            ...truthIdentity("trigger-canonical-tx"),
          },
        ]),
      );
      backend.state.addDueWork(
        runtimeEventIdentity("trigger-canonical-tx"),
        "test.trigger_canonical_tx",
        event!.id,
        10,
      );

      await expect(runtime.runPromise(triggerPump.drainDue(10))).resolves.toEqual({ drained: 1 });
      expect(observed).toEqual({
        inserted: { visible: "stored", hasSecret: false },
        enqueued: { visible: "stored", hasSecret: false },
      });
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
      const [event] = yield* ledger.commit([
        {
          kind: "test.loop.requested",
          payload: { count: 1 },
          ...truthIdentity("loop-scope"),
        },
      ]);
      backend.state.addDueWork(runtimeEventIdentity("loop-scope"), "test.loop", event!.id, 10);

      const exit = yield* Effect.exit(triggerPump.drainUntilQuiet(10, { maxIterations: 2 }));

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure)).toBe(true);
        if (Option.isSome(failure)) {
          expect(failure.value).toBeInstanceOf(DurableTriggerDrainLimitExceeded);
          expect((failure.value as DurableTriggerDrainLimitExceeded).drained).toBe(2);
        }
      }
      expect(backend.state.duePending(runtimeEventIdentity("loop-scope"), 10)).toHaveLength(1);
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
      const [event] = yield* ledger.commit([
        {
          kind: "test.thenable.requested",
          payload: { label: "one" },
          ...truthIdentity("thenable-scope"),
        },
      ]);
      backend.state.addDueWork(
        runtimeEventIdentity("thenable-scope"),
        "test.thenable",
        event!.id,
        10,
      );

      const exit = yield* Effect.exit(triggerPump.drainDue(10));

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure)).toBe(true);
        if (Option.isSome(failure)) {
          expect(failure.value).toBeInstanceOf(DurableTriggerCommitReturnedThenable);
        }
      }
      expect(backend.state.duePending(runtimeEventIdentity("thenable-scope"), 10)).toHaveLength(1);
      const events = yield* ledger.events(truthIdentity("thenable-scope"));
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
      const events = await runtime.runPromise(ledger.events(truthIdentity("schedule-scope")));
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
        InMemoryTriggerPumpLive(state, truthIdentity("empty-registry"), "empty-registry").pipe(
          Layer.provide(Layer.succeed(DurableTriggerRegistry, new Map())),
        ),
      );
      const [event] = yield* state.commitEvents([
        {
          ts: 10,
          kind: "unknown.trigger.requested",
          ...truthIdentity("empty-registry"),
          payload: { ok: true },
        },
      ]);
      state.addDueWork(runtimeEventIdentity("empty-registry"), "unknown.trigger", event!.id, 10);
      const triggerPump = yield* Effect.promise(() => runtime.runPromise(TriggerPump));

      const exit = yield* Effect.exit(triggerPump.drainDue(10));

      expect(Exit.isFailure(exit)).toBe(true);
      expect(state.duePending(runtimeEventIdentity("empty-registry"), 10)).toHaveLength(1);
      yield* Effect.promise(() => runtime.dispose());
    }),
  );

  it.effect("unregistered trigger submit writes no event or due work", () =>
    Effect.gen(function* () {
      const state = createInMemoryBackendState();
      const registry = yield* makeDurableTriggerRegistry([scheduledEventTrigger]);

      const exit = yield* Effect.exit(
        state.commitTriggerIntent(
          runtimeEventIdentity("submit-scope"),
          10,
          registry,
          "missing.trigger",
          () => {
            throw new Error("makeSpec should not run");
          },
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure)).toBe(true);
        if (Option.isSome(failure)) {
          expect(failure.value).toBeInstanceOf(UnregisteredDurableTriggerKind);
          expect((failure.value as UnregisteredDurableTriggerKind).kind).toBe("missing.trigger");
        }
      }
      expect(state.snapshot(truthIdentity("submit-scope"))).toHaveLength(0);
      expect(state.duePending(runtimeEventIdentity("submit-scope"), 10)).toHaveLength(0);
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
      createInMemoryRuntimeBackend({ state, identity: truthIdentity("receiver") }).layer,
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
        identity: truthIdentity("sender"),
        dispatchTargets: {
          [bindingKey]: {
            deliver: (envelope) =>
              receiver.__agentosReceiveDispatch(envelope).then(dispatchTargetDelivered),
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
          scopeRef: { kind: "conversation" as const, scopeId: "receiver" },
          effectAuthorityRef: { authorityClass: "effect", authorityId: "receiver" },
        },
        event: "app.received",
        data: { value: 1 },
        idempotencyKey: "same-key",
      };

      await senderRuntime.runPromise(senderDispatch.dispatchToScope(spec));
      await senderRuntime.runPromise(senderDispatch.dispatchToScope(spec));

      const receiverEvents = await senderRuntime.runPromise(
        senderLedger.events(truthIdentity("receiver")),
      );
      expect(receiverEvents.map((event) => event.kind)).toEqual([
        "dispatch.inbound.accepted",
        "app.received",
      ]);
      const senderEvents = await senderRuntime.runPromise(
        senderLedger.events(truthIdentity("sender")),
      );
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
        resources.grant(truthIdentity("resource-scope"), { key: "credit", amount: 5, ref: "seed" }),
      );
      const first = await runtime.runPromise(
        resources.reserve(truthIdentity("resource-scope"), {
          key: "credit",
          amount: 2,
          ref: "req-1",
          idempotencyKey: "reserve-1",
        }),
      );
      const second = await runtime.runPromise(
        resources.reserve(truthIdentity("resource-scope"), {
          key: "credit",
          amount: 2,
          ref: "req-1-retry",
          idempotencyKey: "reserve-1",
        }),
      );
      expect(second.reservationId).toBe(first.reservationId);
      await expect(
        runtime.runPromise(resources.project(truthIdentity("resource-scope"), "credit")),
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
        runtime.runPromise(
          quota.tryGrant(truthIdentity("quota-scope"), "tool-a", 1, 60_000, 1, "tool-a", "op-1"),
        ),
      ).resolves.toMatchObject({ granted: true, consumed: 0, limit: 1 });
      await expect(
        runtime.runPromise(
          quota.tryGrant(truthIdentity("quota-scope"), "tool-a", 1, 60_000, 1, "tool-a", "op-2"),
        ),
      ).resolves.toMatchObject({ granted: false, consumed: 1, limit: 1 });
      const events = await runtime.runPromise(ledger.events(truthIdentity("quota-scope")));
      expect(events.map((event) => event.kind)).toEqual(["quota.consumed", "quota.rate_limited"]);

      await runtime.runPromise(
        backend.state.commitEvents([
          {
            kind: "quota.consumed",
            ...truthIdentity("quota-scope"),
            payload: { key: "tool-a", amount: "x", toolName: "tool-a", operationRef: "bad-op" },
          },
        ]),
      );
      const exit = await runtime.runPromiseExit(
        quota.tryGrant(
          truthIdentity("quota-scope"),
          "tool-a",
          1,
          Number.POSITIVE_INFINITY,
          10,
          "tool-a",
          "op-3",
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure)).toBe(true);
        if (Option.isSome(failure)) {
          expect(failure.value._tag).toBe("agent_os.runtime_storage_error");
        }
      }
    } finally {
      await runtime.dispose();
    }
  });

  it("AdmissionLive uses injected LlmTransport and commits evidence only", async () => {
    const { runtime } = makeRuntime("admission-scope", {
      llm: { responses: [structuredResponse({ answer: "ok" })] },
    });
    try {
      const admission = await runtime.runPromise(Admission);
      const ledger = await runtime.runPromise(Ledger);
      const schemaSpec = await runtime.runPromise(
        makeAdmissionSchemaSpec(Schema.Struct({ answer: Schema.String })),
      );
      const result = await runtime.runPromise(
        admission.attemptStructured<{ readonly answer: string }>({
          scope: "admission-scope",
          route: {
            kind: "openai-chat-compatible",
            endpointRef: "test-endpoint",
            credentialRef: "test-credential",
            modelId: "test-model",
          },
          schemaSpec,
          strategy: "forced-tool-call",
          stimulus: {
            kind: "live",
            userInput: { userText: "answer" },
          },
        }),
      );

      expect(result.ok).toBe(true);
      const events = await runtime.runPromise(ledger.events(truthIdentity("admission-scope")));
      expect(events.map((event: LedgerEvent) => event.kind)).toEqual(["llm.structured.evidence"]);
    } finally {
      await runtime.dispose();
    }
  });
});
