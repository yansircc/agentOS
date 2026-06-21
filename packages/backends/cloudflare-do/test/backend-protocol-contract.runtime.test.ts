import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe } from "@effect/vitest";
import type {
  BackendProtocolEventIdentity,
  DispatchEnvelope,
  DispatchTargetAdapter,
  DispatchTargetResult,
} from "@agent-os/core/backend-protocol";
import type { EventHandler } from "@agent-os/core/types";
import { RUNTIME_FACT_OWNER } from "@agent-os/core/runtime-protocol";
import { cloudflareRouteKeyFromScopeRef } from "../src/ledger/identity";
import {
  BACKEND_PROTOCOL_CONTRACT_BINDING_REF,
  type BackendProtocolContractTestDO,
} from "./test-worker";
import {
  runRuntimeBackendContractSuite,
  type ContractDispatchReceiver,
  type RuntimeBackendContractDriver,
} from "../../../core/test/backend-protocol/contract/runtime-backend-contract";

interface TestEnv {
  readonly BACKEND_PROTOCOL_CONTRACT_DO: DurableObjectNamespace<BackendProtocolContractTestDO>;
}

type ContractTargetAdapter =
  | DispatchTargetAdapter
  | ((envelope: DispatchEnvelope) => Promise<DispatchTargetResult>);

const testEnv = env as unknown as TestEnv;

const routeKey = (identity: BackendProtocolEventIdentity): string =>
  cloudflareRouteKeyFromScopeRef(identity.scopeRef);

const emptyEventIdentity: BackendProtocolEventIdentity = {
  scopeRef: { kind: "conversation", scopeId: "empty" },
  effectAuthorityRef: { authorityClass: "effect", authorityId: "empty" },
  factOwnerRef: RUNTIME_FACT_OWNER,
};

const makeCloudflareProductionRuntimeContractDriver = (): RuntimeBackendContractDriver => {
  const idPrefix = `backend-protocol-contract-${crypto.randomUUID()}-`;
  const knownRoutes = new Set<string>();
  const handlerRegistrations: Array<{ readonly kind: string; readonly handler: EventHandler }> = [];
  const appliedHandlerCounts = new Map<string, number>();
  const appliedTargetAdapterVersions = new Map<string, number>();
  let targetAdapter: ContractTargetAdapter | undefined;
  let targetAdapterVersion = 0;

  const stubForRoute = (key: string): DurableObjectStub<BackendProtocolContractTestDO> =>
    testEnv.BACKEND_PROTOCOL_CONTRACT_DO.get(
      testEnv.BACKEND_PROTOCOL_CONTRACT_DO.idFromName(idPrefix + key),
    );

  const withInstance = <A>(
    identity: BackendProtocolEventIdentity,
    fn: (instance: BackendProtocolContractTestDO) => A | Promise<A>,
  ): Promise<A> => {
    const key = routeKey(identity);
    knownRoutes.add(key);
    return runInDurableObject(stubForRoute(key), async (instance) => {
      instance.configure({ idPrefix });
      const appliedHandlers = appliedHandlerCounts.get(key) ?? 0;
      if (appliedHandlers < handlerRegistrations.length) {
        for (const registration of handlerRegistrations.slice(appliedHandlers)) {
          instance.addHandler(registration.kind, registration.handler);
        }
        appliedHandlerCounts.set(key, handlerRegistrations.length);
      }

      if ((appliedTargetAdapterVersions.get(key) ?? -1) !== targetAdapterVersion) {
        instance.setDispatchTargetAdapter(targetAdapter);
        appliedTargetAdapterVersions.set(key, targetAdapterVersion);
      }
      return fn(instance);
    });
  };

  return {
    bindingRef: BACKEND_PROTOCOL_CONTRACT_BINDING_REF,
    registerDispatchReceiver: (identity, receiver?: ContractDispatchReceiver) =>
      withInstance(identity, (instance) => {
        instance.registerDispatchReceiver(identity, receiver);
      }),
    setDispatchTargetAdapter: (adapter) => {
      targetAdapter = adapter;
      targetAdapterVersion += 1;
    },
    addHandler: (kind, handler) => {
      const wrapped: EventHandler = (event) => Promise.resolve(handler(event));
      handlerRegistrations.push({ kind, handler: wrapped });
      return {
        unsubscribe: () => {
          // The shared contract never unsubscribes; this is intentionally inert.
        },
      };
    },
    addSink: async (identity, kind, sink) => {
      return withInstance(identity, (instance) => instance.addSink(identity, kind, sink));
    },
    telemetryDiagnostics: async () => {
      const diagnostics = await Promise.all(
        Array.from(knownRoutes, (key) =>
          runInDurableObject(stubForRoute(key), (instance) => instance.telemetryDiagnostics()),
        ),
      );
      return diagnostics.flat();
    },
    log: (identity, kind, payload) =>
      withInstance(identity, (instance) => instance.log(identity, kind, payload)),
    commit: (events) => {
      const identity =
        events[0] === undefined
          ? emptyEventIdentity
          : { ...events[0], factOwnerRef: RUNTIME_FACT_OWNER };
      return withInstance(identity, (instance) => instance.commit(events));
    },
    events: (identity, opts) =>
      withInstance(identity, (instance) => instance.events(identity, opts)),
    streamSnapshot: (identity, opts) =>
      withInstance(identity, (instance) => instance.streamSnapshot(identity, opts)),
    schedule: (identity, at, eventKind, data) =>
      withInstance(identity, (instance) => instance.schedule(identity, at, eventKind, data)),
    fireDue: (identity, now) =>
      withInstance(identity, (instance) => instance.fireDue(identity, now)),
    dispatchToScope: (identity, spec) =>
      withInstance(identity, (instance) => instance.dispatchToScope(identity, spec)),
    receive: (identity, envelope) =>
      withInstance(identity, (instance) => instance.__agentosReceiveDispatch(envelope)),
    drainDispatchDue: (identity, now) =>
      withInstance(identity, (instance) => instance.drainDispatchDue(identity, now)),
    nextDueAt: (identity) => withInstance(identity, (instance) => instance.nextDueAt(identity)),
    pendingDueCount: (identity) =>
      withInstance(identity, (instance) => Promise.resolve(instance.pendingDueCount())),
    grantResource: (identity, spec) =>
      withInstance(identity, (instance) => instance.grantResource(identity, spec)),
    reserveResource: (identity, spec) =>
      withInstance(identity, (instance) => instance.reserveResource(identity, spec)),
    consumeResource: (identity, spec) =>
      withInstance(identity, (instance) => instance.consumeResource(identity, spec)),
    releaseResource: (identity, spec) =>
      withInstance(identity, (instance) => instance.releaseResource(identity, spec)),
    projectResource: (key) => withInstance(key, (instance) => instance.projectResource(key)),
    quotaTryGrant: (identity, key, amount, windowMs, limit, toolName, operationRef) =>
      withInstance(identity, (instance) =>
        instance.quotaTryGrant(identity, key, amount, windowMs, limit, toolName, operationRef),
      ),
    dispose: async () => {
      await Promise.all(
        Array.from(knownRoutes, (key) =>
          runInDurableObject(stubForRoute(key), (instance) => instance.disposeDriver()),
        ),
      );
      knownRoutes.clear();
    },
  };
};

describe("cloudflare-do production runtime backend protocol driver", () => {
  runRuntimeBackendContractSuite(
    "cloudflare-do production runtime",
    makeCloudflareProductionRuntimeContractDriver,
    {
      runtimeFactOwner: RUNTIME_FACT_OWNER,
    },
  );
});
