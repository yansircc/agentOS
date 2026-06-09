import { randomUUID } from "node:crypto";
import { describe } from "@effect/vitest";
import { afterAll, beforeAll } from "vitest";
import { bindingMaterialRef } from "@agent-os/kernel/material-ref";
import { RUNTIME_FACT_OWNER } from "@agent-os/runtime-protocol";
import {
  NodePostgresBackend,
  type NodePostgresEventSubscription,
} from "../src";
import {
  runRuntimeBackendContractSuite,
  type ContractDispatchReceiver,
  type RuntimeBackendContractDriver,
} from "../../protocol/test/contract/runtime-backend-contract";
import { startPostgresRuntimeHarness, type PostgresRuntimeHarness } from "./postgres-harness";

const bindingRef = bindingMaterialRef({
  provider: "node",
  bindingKind: "postgres",
  ref: "receiver",
});

let harness: PostgresRuntimeHarness | undefined;

beforeAll(async () => {
  harness = await startPostgresRuntimeHarness();
}, 120_000);

afterAll(async () => {
  await harness?.cleanup();
}, 120_000);

const makeNodePostgresContractDriver = async (): Promise<RuntimeBackendContractDriver> => {
  if (harness === undefined) throw new Error("postgres harness not started");
  const backend = new NodePostgresBackend({
    databaseUrl: harness.databaseUrl,
    schema: `agentos_contract_${randomUUID().replace(/-/g, "_")}`,
    bindingRef,
  });
  await backend.initialize();
  return {
    bindingRef,
    registerDispatchReceiver: (
      identity,
      receiver?: ContractDispatchReceiver,
    ): void => {
      backend.registerDispatchReceiver(identity, receiver);
    },
    setDispatchTargetAdapter: (adapter): void => {
      backend.setDispatchTargetAdapter(adapter);
    },
    addHandler: (kind, handler): NodePostgresEventSubscription =>
      backend.addHandler(kind, (event) => Promise.resolve(handler(event))),
    addSink: (identity, kind, sink): NodePostgresEventSubscription =>
      backend.addSink(identity, kind, sink),
    telemetryDiagnostics: () => backend.telemetryDiagnostics(),
    log: (identity, kind, payload) => backend.log(identity, kind, payload),
    events: (identity) => backend.events(identity),
    schedule: (identity, at, eventKind, data) =>
      backend.schedule(identity, at, eventKind, data),
    fireDue: (identity, now) => backend.fireDue(identity, now),
    dispatchToScope: (identity, spec) => backend.dispatchToScope(identity, spec),
    drainDispatchDue: (identity, now) => backend.drainDispatchDue(identity, now),
    nextDueAt: (identity) => backend.nextDueAt(identity),
    pendingDueCount: (identity) => backend.pendingDueCount(identity),
    grantResource: (identity, spec) => backend.grantResource(identity, spec),
    reserveResource: (identity, spec) => backend.reserveResource(identity, spec),
    consumeResource: (identity, spec) => backend.consumeResource(identity, spec),
    releaseResource: (identity, spec) => backend.releaseResource(identity, spec),
    projectResource: (key) => backend.projectResource(key),
    quotaTryGrant: (identity, key, amount, windowMs, limit, toolName, operationRef) =>
      backend.quotaTryGrant(identity, key, amount, windowMs, limit, toolName, operationRef),
    dispose: () => backend.dispose(),
  };
};

describe("node-postgres backend protocol driver", () => {
  runRuntimeBackendContractSuite("node-postgres", makeNodePostgresContractDriver, {
    runtimeFactOwner: RUNTIME_FACT_OWNER,
  });
});
