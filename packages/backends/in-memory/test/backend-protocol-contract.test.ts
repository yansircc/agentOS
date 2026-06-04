import { ManagedRuntime } from "effect";
import { describe } from "@effect/vitest";
import { bindingMaterialRef, materialRefKey } from "@agent-os/kernel/material-ref";
import { DISPATCH_EVENT_KINDS } from "@agent-os/backend-protocol";
import {
  Dispatch,
  Ledger,
  Quota,
  Resources,
  Scheduler,
  TriggerPump,
  type DispatchReceiver,
  type DispatchTargetAdapter,
} from "@agent-os/runtime";
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
  const makeRuntime = (scope: string) =>
    ManagedRuntime.make(
      createInMemoryRuntimeBackend({
        state,
        scope,
        dispatchTargets: targets,
      }).layer,
    );
  type RuntimeHandle = ReturnType<typeof makeRuntime>;
  const runtimes = new Map<string, RuntimeHandle>();
  const runtime = (scope: string): RuntimeHandle => {
    const existing = runtimes.get(scope);
    if (existing !== undefined) return existing;
    const created = makeRuntime(scope);
    runtimes.set(scope, created);
    return created;
  };

  const acceptDispatch = async (
    scope: string,
    envelope: Parameters<DispatchReceiver["__agentosReceiveDispatch"]>[0],
  ) => {
    const dispatch = await runtime(scope).runPromise(Dispatch);
    return runtime(scope).runPromise(dispatch.receive(envelope));
  };

  const registerDispatchReceiver = (scope: string, receiver?: ContractDispatchReceiver): void => {
    receiverTargets.set(scope, {
      __agentosReceiveDispatch: (envelope) => {
        const accept = () => acceptDispatch(scope, envelope);
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
    log: async (scope, kind, payload) => {
      const ledger = await runtime(scope).runPromise(Ledger);
      return runtime(scope).runPromise(ledger.log(kind, payload, scope));
    },
    events: async (scope) => {
      const ledger = await runtime(scope).runPromise(Ledger);
      return runtime(scope).runPromise(ledger.events(scope));
    },
    schedule: async (scope, at, eventKind, data) => {
      const scheduler = await runtime(scope).runPromise(Scheduler);
      return runtime(scope).runPromise(scheduler.schedule(at, eventKind, data));
    },
    fireDue: async (scope, now) => {
      const triggerPump = await runtime(scope).runPromise(TriggerPump);
      const result = await runtime(scope).runPromise(triggerPump.drainDue(now));
      return { fired: result.drained };
    },
    dispatchToScope: async (scope, spec) => {
      const dispatch = await runtime(scope).runPromise(Dispatch);
      return runtime(scope).runPromise(dispatch.dispatchToScope(spec));
    },
    drainDispatchDue: async (scope, now) => {
      const before = await runtime(scope).runPromise(
        (await runtime(scope).runPromise(Ledger)).events(scope),
      );
      const triggerPump = await runtime(scope).runPromise(TriggerPump);
      await runtime(scope).runPromise(triggerPump.drainDue(now));
      const after = await runtime(scope).runPromise(
        (await runtime(scope).runPromise(Ledger)).events(scope),
      );
      const slice = after.slice(before.length);
      return {
        delivered: slice.filter((event) => event.kind === DISPATCH_EVENT_KINDS.OUTBOUND_DELIVERED)
          .length,
        failed: slice.filter((event) => event.kind === DISPATCH_EVENT_KINDS.OUTBOUND_FAILED).length,
      };
    },
    nextDueAt: () => Promise.resolve(state.nextDueAt()),
    pendingDueCount: () =>
      Promise.resolve(pendingDueRows().filter((row) => row.completedAt === null).length),
    grantResource: async (scope, spec) => {
      const resources = await runtime(scope).runPromise(Resources);
      return runtime(scope).runPromise(resources.grant(scope, spec));
    },
    reserveResource: async (scope, spec) => {
      const resources = await runtime(scope).runPromise(Resources);
      return runtime(scope).runPromise(resources.reserve(scope, spec));
    },
    consumeResource: async (scope, spec) => {
      const resources = await runtime(scope).runPromise(Resources);
      return runtime(scope).runPromise(resources.consume(scope, spec));
    },
    releaseResource: async (scope, spec) => {
      const resources = await runtime(scope).runPromise(Resources);
      return runtime(scope).runPromise(resources.release(scope, spec));
    },
    projectResource: async (scope, key) => {
      const resources = await runtime(scope).runPromise(Resources);
      return runtime(scope).runPromise(resources.project(scope, key));
    },
    quotaTryGrant: async (scope, key, amount, windowMs, limit, toolName, operationRef) => {
      const quota = await runtime(scope).runPromise(Quota);
      return runtime(scope).runPromise(
        quota.tryGrant(scope, key, amount, windowMs, limit, toolName, operationRef),
      );
    },
    dispose: async () => {
      await Promise.all(Array.from(runtimes.values(), (handle) => handle.dispose()));
    },
  };
};

describe("in-memory backend protocol driver", () => {
  runRuntimeBackendContractSuite("in-memory", makeInMemoryContractDriver);
});
