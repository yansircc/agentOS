import type { EventHandler, LedgerEvent } from "@agent-os/kernel/types";
import { ManagedRuntime } from "effect";
import { describe } from "@effect/vitest";
import { bindingMaterialRef, materialRefKey } from "@agent-os/kernel/material-ref";
import {
  Dispatch,
  Ledger,
  Quota,
  Resources,
  Scheduler,
  type DispatchReceiver,
  type DispatchTargetAdapter,
} from "@agent-os/runtime";
import { durableObjectDispatchTarget, type DispatchTargetNamespace } from "../src/dispatch";
import { findNextDue } from "../src/due-work";
import { makeCloudflareBackendCoreLayer } from "../src/runtime-core";
import { makeInMemoryDurableObjectState } from "./_in-memory-do";
import {
  runRuntimeBackendContractSuite,
  type ContractDispatchReceiver,
  type RuntimeBackendContractDriver,
} from "../../protocol/test/contract/runtime-backend-contract";

const bindingRef = bindingMaterialRef({
  provider: "cloudflare",
  bindingKind: "durable_object",
  ref: "receiver",
});

const bindingKey = materialRefKey(bindingRef);

const makeCloudflareDoContractDriver = (): RuntimeBackendContractDriver => {
  const handlers = new Map<string, Set<EventHandler>>();
  const states = new Map<string, DurableObjectState>();
  const receiverTargets = new Map<string, DispatchReceiver>();

  const targetNamespace: DispatchTargetNamespace = {
    idFromName: (name) => ({ name }) as unknown as DurableObjectId,
    get: (id) => {
      const scope = (id as { readonly name?: string }).name;
      return scope === undefined ? undefined : receiverTargets.get(scope);
    },
  };
  const targets: Record<string, DispatchTargetAdapter> = {
    [bindingKey]: durableObjectDispatchTarget(targetNamespace),
  };

  const stateFor = (scope: string): DurableObjectState => {
    const existing = states.get(scope);
    if (existing !== undefined) return existing;
    const created = makeInMemoryDurableObjectState();
    states.set(scope, created);
    return created;
  };

  const makeRuntime = (scope: string) => {
    const state = stateFor(scope);
    return ManagedRuntime.make(makeCloudflareBackendCoreLayer(state, scope, handlers, targets));
  };
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
    addHandler: (kind, handler) => {
      let set = handlers.get(kind);
      if (set === undefined) {
        set = new Set();
        handlers.set(kind, set);
      }
      const wrapped: EventHandler = (event) => Promise.resolve(handler(event as LedgerEvent));
      set.add(wrapped);
      return {
        unsubscribe: () => {
          set?.delete(wrapped);
        },
      };
    },
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
      const scheduler = await runtime(scope).runPromise(Scheduler);
      return runtime(scope).runPromise(scheduler.fireDue(now));
    },
    dispatchToScope: async (scope, spec) => {
      const dispatch = await runtime(scope).runPromise(Dispatch);
      return runtime(scope).runPromise(dispatch.dispatchToScope(spec));
    },
    drainDispatchDue: async (scope, now) => {
      const dispatch = await runtime(scope).runPromise(Dispatch);
      return runtime(scope).runPromise(dispatch.drainDue(now));
    },
    nextDueAt: (scope) => runtime(scope).runPromise(findNextDue(stateFor(scope).storage.sql)),
    pendingDueCount: (scope) =>
      Promise.resolve(
        stateFor(scope)
          .storage.sql.exec("SELECT * FROM due_work WHERE completed_at IS NULL")
          .toArray().length,
      ),
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
    quotaTryGrant: async (scope, key, amount, windowMs, limit, toolName) => {
      const quota = await runtime(scope).runPromise(Quota);
      return runtime(scope).runPromise(
        quota.tryGrant(scope, key, amount, windowMs, limit, toolName),
      );
    },
    dispose: async () => {
      await Promise.all(Array.from(runtimes.values(), (handle) => handle.dispose()));
    },
  };
};

describe("cloudflare-do backend protocol driver", () => {
  runRuntimeBackendContractSuite("cloudflare-do", makeCloudflareDoContractDriver);
});
