import type { EventHandler, LedgerEvent } from "@agent-os/kernel/types";
import { ManagedRuntime } from "effect";
import { describe } from "@effect/vitest";
import { bindingMaterialRef, materialRefKey } from "@agent-os/kernel/material-ref";
import { Dispatch, Ledger, Quota, Resources, Scheduler, TriggerPump } from "@agent-os/runtime";
import { RUNTIME_FACT_OWNER } from "@agent-os/runtime-protocol";
import {
  DISPATCH_EVENT_KINDS,
  type BackendProtocolEventIdentity,
  type DispatchReceiver,
  type DispatchTargetAdapter,
} from "@agent-os/backend-protocol";
import { durableObjectDispatchTarget, type DispatchTargetNamespace } from "../src/dispatch";
import { findNextDue } from "../src/due-work";
import { EventBus } from "../src/ledger";
import { cloudflareRouteKeyFromScopeRef } from "../src/ledger/identity";
import { makeCloudflareBackendCoreLayer } from "../src/runtime-core";
import { makeInMemoryDurableObjectState } from "./_in-memory-do";
import {
  runRuntimeBackendContractSuite,
  type ContractDispatchReceiver,
  type RuntimeBackendContractDriver,
} from "../../protocol/test/contract/runtime-backend-contract";
import type { TelemetryFanoutDiagnostic } from "@agent-os/telemetry-protocol";

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

  const makeRuntime = (scope: string, identity: BackendProtocolEventIdentity) => {
    const state = stateFor(scope);
    return ManagedRuntime.make(
      makeCloudflareBackendCoreLayer(state, {}, scope, identity, handlers, targets),
    );
  };
  type RuntimeHandle = ReturnType<typeof makeRuntime>;
  const runtimes = new Map<string, RuntimeHandle>();
  const runtime = (scope: string, identity: BackendProtocolEventIdentity): RuntimeHandle => {
    const existing = runtimes.get(scope);
    if (existing !== undefined) return existing;
    const created = makeRuntime(scope, identity);
    runtimes.set(scope, created);
    return created;
  };

  const routeKey = (identity: BackendProtocolEventIdentity): string =>
    cloudflareRouteKeyFromScopeRef(identity.scopeRef);

  const runtimeFor = (identity: BackendProtocolEventIdentity): RuntimeHandle =>
    runtime(routeKey(identity), identity);

  const stateForIdentity = (identity: BackendProtocolEventIdentity): DurableObjectState =>
    stateFor(routeKey(identity));

  const acceptDispatch = async (
    identity: BackendProtocolEventIdentity,
    envelope: Parameters<DispatchReceiver["__agentosReceiveDispatch"]>[0],
  ) => {
    const handle = runtimeFor(identity);
    const dispatch = await handle.runPromise(Dispatch);
    return handle.runPromise(dispatch.receive(envelope));
  };

  const registerDispatchReceiver = (
    identity: BackendProtocolEventIdentity,
    receiver?: ContractDispatchReceiver,
  ): void => {
    receiverTargets.set(routeKey(identity), {
      __agentosReceiveDispatch: (envelope) => {
        const accept = () => acceptDispatch(identity, envelope);
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
    addSink: async (identity, kind, sink) => {
      const bus = await runtimeFor(identity).runPromise(EventBus);
      return bus.subscribe({ kinds: [kind], sink });
    },
    telemetryDiagnostics: async () => {
      const diagnostics: TelemetryFanoutDiagnostic[] = [];
      for (const handle of runtimes.values()) {
        const bus = await handle.runPromise(EventBus);
        diagnostics.push(...bus.telemetryDiagnostics());
      }
      return diagnostics;
    },
    log: async (identity, kind, payload) => {
      const handle = runtimeFor(identity);
      const ledger = await handle.runPromise(Ledger);
      const events = await handle.runPromise(
        ledger.commit([
          {
            kind,
            payload,
            scopeRef: identity.scopeRef,
            effectAuthorityRef: identity.effectAuthorityRef,
          },
        ]),
      );
      const event = events[0];
      if (event === undefined) throw new Error("ledger commit returned no event");
      return event;
    },
    events: async (identity) => {
      const handle = runtimeFor(identity);
      const ledger = await handle.runPromise(Ledger);
      return handle.runPromise(ledger.events(identity));
    },
    schedule: async (identity, at, eventKind, data) => {
      const handle = runtimeFor(identity);
      const scheduler = await handle.runPromise(Scheduler);
      return handle.runPromise(scheduler.schedule(at, eventKind, data));
    },
    fireDue: async (identity, now) => {
      const handle = runtimeFor(identity);
      const triggerPump = await handle.runPromise(TriggerPump);
      const result = await handle.runPromise(triggerPump.drainDue(now));
      return { fired: result.drained };
    },
    dispatchToScope: async (identity, spec) => {
      const handle = runtimeFor(identity);
      const dispatch = await handle.runPromise(Dispatch);
      return handle.runPromise(dispatch.dispatchToScope(spec));
    },
    drainDispatchDue: async (identity, now) => {
      const handle = runtimeFor(identity);
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
    nextDueAt: (identity) =>
      runtimeFor(identity).runPromise(findNextDue(stateForIdentity(identity).storage.sql)),
    pendingDueCount: (identity) =>
      Promise.resolve(
        stateForIdentity(identity)
          .storage.sql.exec("SELECT * FROM due_work WHERE completed_at IS NULL")
          .toArray().length,
      ),
    grantResource: async (identity, spec) => {
      const handle = runtimeFor(identity);
      const resources = await handle.runPromise(Resources);
      return handle.runPromise(resources.grant(identity, spec));
    },
    reserveResource: async (identity, spec) => {
      const handle = runtimeFor(identity);
      const resources = await handle.runPromise(Resources);
      return handle.runPromise(resources.reserve(identity, spec));
    },
    consumeResource: async (identity, spec) => {
      const handle = runtimeFor(identity);
      const resources = await handle.runPromise(Resources);
      return handle.runPromise(resources.consume(identity, spec));
    },
    releaseResource: async (identity, spec) => {
      const handle = runtimeFor(identity);
      const resources = await handle.runPromise(Resources);
      return handle.runPromise(resources.release(identity, spec));
    },
    projectResource: async (key) => {
      const handle = runtimeFor(key);
      const resources = await handle.runPromise(Resources);
      return handle.runPromise(resources.project(key, key.projectionId));
    },
    quotaTryGrant: async (identity, key, amount, windowMs, limit, toolName, operationRef) => {
      const handle = runtimeFor(identity);
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

describe("cloudflare-do backend protocol driver", () => {
  runRuntimeBackendContractSuite("cloudflare-do", makeCloudflareDoContractDriver, {
    runtimeFactOwner: RUNTIME_FACT_OWNER,
  });
});
