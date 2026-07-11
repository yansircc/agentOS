import { ManagedRuntime } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { bindingMaterialRef, materialRefKey } from "@agent-os/core/material-ref";
import {
  DISPATCH_EVENT_KINDS,
  BACKEND_CONFORMANCE_LAW_ID,
  backendProtocolEventIdentityKey,
  backendProtocolTruthIdentityKey,
  dispatchTargetDelivered,
  type BackendProtocolEventIdentity,
  type BackendProtocolTruthIdentity,
  type DispatchReceiver,
  type DispatchTargetAdapter,
} from "@agent-os/core/backend-protocol";
import { Dispatch, Ledger, Quota, Resources, Scheduler, TriggerPump } from "@agent-os/runtime";
import { RUNTIME_FACT_OWNER } from "@agent-os/core/runtime-protocol";
import { createTestInMemoryBackendState, createTestInMemoryRuntimeBackend } from "./runtime-helper";
import {
  registerBackendConformanceSuite,
  runBackendConformance,
  type ContractDispatchReceiver,
  type RuntimeBackendContractDriver,
} from "@agent-os/runtime/testing";
import { VITEST_BACKEND_CONFORMANCE_REGISTRAR } from "../backend-conformance-registrar";

const bindingRef = bindingMaterialRef({
  provider: "test",
  bindingKind: "do",
  ref: "receiver",
});

const bindingKey = materialRefKey(bindingRef);

const truthIdentity = (identity: BackendProtocolTruthIdentity): BackendProtocolTruthIdentity => ({
  scopeRef: identity.scopeRef,
  effectAuthorityRef: identity.effectAuthorityRef,
});

const emptyTruthIdentity: BackendProtocolTruthIdentity = {
  scopeRef: { kind: "conversation", scopeId: "empty" },
  effectAuthorityRef: { authorityClass: "effect", authorityId: "empty" },
};

const makeInMemoryContractDriver = (): RuntimeBackendContractDriver => {
  const state = createTestInMemoryBackendState();
  const receiverTargets = new Map<string, DispatchReceiver>();
  const targetAdapter: DispatchTargetAdapter = {
    deliver: (envelope) => {
      const receiver = receiverTargets.get(envelope.targetScope);
      return receiver === undefined
        ? Promise.reject(`missing receiver target ${envelope.targetScope}`)
        : receiver.__agentosReceiveDispatch(envelope).then(dispatchTargetDelivered);
    },
  };
  const targets: Record<string, DispatchTargetAdapter> = { [bindingKey]: targetAdapter };
  const makeRuntime = (identity: BackendProtocolTruthIdentity) =>
    ManagedRuntime.make(
      createTestInMemoryRuntimeBackend({
        state,
        identity: truthIdentity(identity),
        dispatchTargets: targets,
      }).layer,
    );
  type RuntimeHandle = ReturnType<typeof makeRuntime>;
  const runtimes = new Map<string, RuntimeHandle>();
  const runtime = (identity: BackendProtocolTruthIdentity): RuntimeHandle => {
    const key = backendProtocolTruthIdentityKey(identity);
    const existing = runtimes.get(key);
    if (existing !== undefined) return existing;
    const created = makeRuntime(identity);
    runtimes.set(key, created);
    return created;
  };

  const acceptDispatch = async (
    identity: BackendProtocolEventIdentity,
    envelope: Parameters<DispatchReceiver["__agentosReceiveDispatch"]>[0],
  ) => {
    const handle = runtime(identity);
    const dispatch = await handle.runPromise(Dispatch);
    return handle.runPromise(dispatch.receive(envelope));
  };

  const registerDispatchReceiver = (
    identity: BackendProtocolEventIdentity,
    receiver?: ContractDispatchReceiver,
  ): void => {
    receiverTargets.set(backendProtocolTruthIdentityKey(identity), {
      __agentosReceiveDispatch: (envelope) => {
        const accept = () => acceptDispatch(identity, envelope);
        return receiver === undefined ? accept() : receiver(envelope, accept);
      },
    });
  };

  const pendingDueRows = (): ReadonlyArray<{ readonly completedAt: number | null }> => {
    const exposed = state as unknown as {
      readonly dueWork: ReadonlyArray<{ readonly completedAt: number | null }>;
    };
    return exposed.dueWork;
  };

  return {
    bindingRef,
    registerDispatchReceiver,
    setDispatchTargetAdapter: (adapter) => {
      targets[bindingKey] =
        typeof adapter === "function"
          ? {
              deliver: adapter,
            }
          : adapter;
    },
    addHandler: (kind, handler) =>
      state.addHandler(kind, (event) => Promise.resolve(handler(event))),
    addSink: (_scope, kind, sink) => state.subscribe({ kinds: [kind], sink }),
    telemetryDiagnostics: () => state.telemetryDiagnostics(),
    log: async (identity, kind, payload) => {
      const handle = runtime(identity);
      const ledger = await handle.runPromise(Ledger);
      const events = await handle.runPromise(
        ledger.commit([{ kind, payload, ...truthIdentity(identity) }]),
      );
      const event = events[0];
      if (event === undefined) throw new Error("ledger commit returned no event");
      return event;
    },
    commit: async (events) => {
      const handle = runtime(events[0] ?? emptyTruthIdentity);
      const ledger = await handle.runPromise(Ledger);
      return handle.runPromise(ledger.commit(events));
    },
    events: async (identity, opts) => {
      const handle = runtime(identity);
      const ledger = await handle.runPromise(Ledger);
      return handle.runPromise(ledger.events(identity, opts));
    },
    streamSnapshot: async (identity, opts) => {
      const handle = runtime(identity);
      const ledger = await handle.runPromise(Ledger);
      return handle.runPromise(ledger.streamSnapshot(identity, opts));
    },
    schedule: async (identity, at, eventKind, data) => {
      const handle = runtime(identity);
      const scheduler = await handle.runPromise(Scheduler);
      return handle.runPromise(scheduler.schedule(at, eventKind, data));
    },
    fireDue: async (identity, now) => {
      const handle = runtime(identity);
      const triggerPump = await handle.runPromise(TriggerPump);
      const result = await handle.runPromise(triggerPump.drainDue(now));
      return { fired: result.drained };
    },
    dispatchToScope: async (identity, spec) => {
      const handle = runtime(identity);
      const dispatch = await handle.runPromise(Dispatch);
      return handle.runPromise(dispatch.dispatchToScope(spec));
    },
    receive: acceptDispatch,
    receiveConcurrent: (identity, envelopes) =>
      Promise.all(envelopes.map((envelope) => acceptDispatch(identity, envelope))),
    drainDispatchDue: async (identity, now) => {
      const handle = runtime(identity);
      const ledger = await handle.runPromise(Ledger);
      const before = await handle.runPromise(ledger.events(identity));
      const triggerPump = await handle.runPromise(TriggerPump);
      const result = await handle.runPromise(triggerPump.drainDue(now));
      if (result.drained === 0) return { delivered: 0, failed: 0 };
      const after = await handle.runPromise(ledger.events(identity));
      const slice = after.slice(before.length);
      return {
        delivered: slice.filter((event) => event.kind === DISPATCH_EVENT_KINDS.OUTBOUND_DELIVERED)
          .length,
        failed: slice.filter((event) => event.kind === DISPATCH_EVENT_KINDS.OUTBOUND_FAILED).length,
      };
    },
    nextDueAt: (identity) => Promise.resolve(state.nextDueAt(identity)),
    pendingDueCount: (identity) =>
      Promise.resolve(
        pendingDueRows().filter(
          (row) =>
            row.completedAt === null &&
            (row as { readonly identityKey?: string }).identityKey ===
              backendProtocolEventIdentityKey(identity),
        ).length,
      ),
    grantResource: async (identity, spec) => {
      const handle = runtime(identity);
      const resources = await handle.runPromise(Resources);
      return handle.runPromise(resources.grant(identity, spec));
    },
    reserveResource: async (identity, spec) => {
      const handle = runtime(identity);
      const resources = await handle.runPromise(Resources);
      return handle.runPromise(resources.reserve(identity, spec));
    },
    consumeResource: async (identity, spec) => {
      const handle = runtime(identity);
      const resources = await handle.runPromise(Resources);
      return handle.runPromise(resources.consume(identity, spec));
    },
    releaseResource: async (identity, spec) => {
      const handle = runtime(identity);
      const resources = await handle.runPromise(Resources);
      return handle.runPromise(resources.release(identity, spec));
    },
    projectResource: async (key) => {
      const handle = runtime(key);
      const resources = await handle.runPromise(Resources);
      return handle.runPromise(resources.project(key, key.projectionId));
    },
    quotaTryGrant: async (identity, key, amount, windowMs, limit, toolName, operationRef) => {
      const handle = runtime(identity);
      const quota = await handle.runPromise(Quota);
      return handle.runPromise(
        quota.tryGrant(identity, key.projectionId, amount, windowMs, limit, toolName, operationRef),
      );
    },
    dispose: async () => {
      await Promise.all(Array.from(runtimes.values(), (handle) => handle.dispose()));
    },
  };
};

registerBackendConformanceSuite(
  VITEST_BACKEND_CONFORMANCE_REGISTRAR,
  "in-memory",
  makeInMemoryContractDriver,
  { runtimeFactOwner: RUNTIME_FACT_OWNER },
);

const expectBrokenLaw = async (
  backendId: string,
  mutate: (driver: RuntimeBackendContractDriver) => RuntimeBackendContractDriver,
  lawId: string,
): Promise<void> => {
  const report = await runBackendConformance(
    backendId,
    () => mutate(makeInMemoryContractDriver()),
    { runtimeFactOwner: RUNTIME_FACT_OWNER },
  );
  expect(report.ok).toBe(false);
  expect(report.results.find((result) => result.lawId === lawId)?.status).toBe("failed");
};

describe("backend conformance red cases", () => {
  it("rejects a backend that lies about page limits", async () => {
    await expectBrokenLaw(
      "broken-page-policy",
      (driver) => ({
        ...driver,
        events: (identity, options) =>
          identity.scopeRef.scopeId === "ledger-prefix" && options?.limit === 2
            ? driver.events(identity)
            : driver.events(identity, options),
      }),
      BACKEND_CONFORMANCE_LAW_ID.LEDGER_READ_PREFIX,
    );
  });

  it("rejects a backend that exposes a partial batch after rejection", async () => {
    await expectBrokenLaw(
      "broken-batch-atomicity",
      (driver) => ({
        ...driver,
        commit: async (events) => {
          if (events.some((event) => event.kind.startsWith("ledger_law.batch"))) {
            await driver.commit(events.slice(0, 1));
            throw new Error("partial batch committed");
          }
          return driver.commit(events);
        },
      }),
      BACKEND_CONFORMANCE_LAW_ID.LEDGER_BATCH_ATOMICITY,
    );
  });

  it("rejects acknowledgement before a durable read", async () => {
    await expectBrokenLaw(
      "broken-durable-ack",
      (driver) => ({
        ...driver,
        events: (identity, options) =>
          identity.scopeRef.scopeId === "ledger-durable-ack"
            ? Promise.resolve([])
            : driver.events(identity, options),
      }),
      BACKEND_CONFORMANCE_LAW_ID.LEDGER_DURABLE_ACK,
    );
  });

  it("rejects non-linearized concurrent dispatch receives", async () => {
    await expectBrokenLaw(
      "broken-dispatch-linearization",
      (driver) => ({
        ...driver,
        receiveConcurrent: (identity, envelopes) =>
          driver.receiveConcurrent(
            identity,
            envelopes.map((envelope) => ({
              ...envelope,
              idempotencyKey: `${envelope.idempotencyKey}:${envelope.outboundEventId}`,
            })),
          ),
      }),
      BACKEND_CONFORMANCE_LAW_ID.DISPATCH_CONCURRENT_RECEIVE_LINEARIZATION,
    );
  });

  it("rejects non-serialized concurrent resource reservations", async () => {
    await expectBrokenLaw(
      "broken-resource-serialization",
      (driver) => {
        let sharedReservation:
          | ReturnType<RuntimeBackendContractDriver["reserveResource"]>
          | undefined;
        return {
          ...driver,
          reserveResource: (identity, spec) => {
            if (identity.scopeRef.scopeId !== "resource-concurrent-reserve") {
              return driver.reserveResource(identity, spec);
            }
            sharedReservation ??= driver.reserveResource(identity, spec);
            return sharedReservation;
          },
        };
      },
      BACKEND_CONFORMANCE_LAW_ID.RESOURCE_CONCURRENT_SERIALIZATION,
    );
  });
});
