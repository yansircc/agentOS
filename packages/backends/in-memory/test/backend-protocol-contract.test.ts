import { ManagedRuntime } from "effect";
import { describe } from "@effect/vitest";
import { bindingMaterialRef, materialRefKey } from "@agent-os/kernel/material-ref";
import {
  DISPATCH_EVENT_KINDS,
  backendProtocolEventIdentityKey,
  backendProtocolTruthIdentityKey,
  type BackendProtocolEventIdentity,
  type BackendProtocolTruthIdentity,
  type DispatchReceiver,
  type DispatchTargetAdapter,
} from "@agent-os/backend-protocol";
import { Dispatch, Ledger, Quota, Resources, Scheduler, TriggerPump } from "@agent-os/runtime";
import { RUNTIME_FACT_OWNER } from "@agent-os/runtime-protocol";
import { createInMemoryBackendState, createInMemoryRuntimeBackend } from "../src";
import {
  runRuntimeBackendContractSuite,
  type ContractDispatchReceiver,
  type RuntimeBackendContractDriver,
} from "../../protocol/test/contract/runtime-backend-contract";

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

const makeInMemoryContractDriver = (): RuntimeBackendContractDriver => {
  const state = createInMemoryBackendState();
  const receiverTargets = new Map<string, DispatchReceiver>();
  const targetAdapter: DispatchTargetAdapter = {
    deliver: (envelope) => {
      const receiver = receiverTargets.get(envelope.targetScope);
      return receiver === undefined
        ? Promise.reject(`missing receiver target ${envelope.targetScope}`)
        : receiver.__agentosReceiveDispatch(envelope);
    },
  };
  const targets: Record<string, DispatchTargetAdapter> = { [bindingKey]: targetAdapter };
  const makeRuntime = (identity: BackendProtocolTruthIdentity) =>
    ManagedRuntime.make(
      createInMemoryRuntimeBackend({
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
    fanoutDiagnostics: () => state.fanoutDiagnostics(),
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
    events: async (identity) => {
      const handle = runtime(identity);
      const ledger = await handle.runPromise(Ledger);
      return handle.runPromise(ledger.events(identity));
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

describe("in-memory backend protocol driver", () => {
  runRuntimeBackendContractSuite("in-memory", makeInMemoryContractDriver, {
    runtimeFactOwner: RUNTIME_FACT_OWNER,
  });
});
