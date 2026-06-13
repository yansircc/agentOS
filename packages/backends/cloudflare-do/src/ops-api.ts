import type {
  EventQueryOptions,
  LedgerEventRpc,
  QuotaState,
  ResourceState,
  RunListPage,
  RunListSpec,
  RunStatus,
  RunTrace,
  StreamEventsOptions,
} from "@agent-os/kernel/types";
import type { AttemptKey, CapabilityLease } from "@agent-os/runtime-protocol";
import type { BackendProtocolTruthIdentity } from "@agent-os/backend-protocol";
import type { AgentDOIntrospection, ResolvedScope } from "@agent-os/ops-api";
import { cloudflareDefaultTruthIdentityFromRoutingScope } from "./ledger/identity";

export interface CloudflareAgentDOResolvedScope extends ResolvedScope {
  readonly namespace: DurableObjectNamespace;
  readonly truthIdentity?: BackendProtocolTruthIdentity;
}

export interface CloudflareAgentDOIntrospectionRpc {
  events(
    identity: BackendProtocolTruthIdentity,
    opts?: EventQueryOptions,
  ): Promise<LedgerEventRpc[]>;
  streamEvents(identity: BackendProtocolTruthIdentity, opts?: StreamEventsOptions): Response;
  runs(spec: RunListSpec): Promise<RunListPage>;
  runTrace(runId: number | string): Promise<RunTrace>;
  runStatus(runId: number | string): Promise<RunStatus>;
  quotaState(spec: { key: string; windowMs: number; limit: number }): Promise<QuotaState>;
  resourceState(key: string): Promise<ResourceState>;
  admissionLease(key: AttemptKey): Promise<CapabilityLease | null>;
}

export const cloudflareAgentDoOpsStubFor = (
  resolved: ResolvedScope,
): AgentDOIntrospection | null => {
  if (resolved.surface !== "agent-do/v0.3" || !("namespace" in resolved)) return null;
  const scope = resolved as CloudflareAgentDOResolvedScope;
  const id = scope.namespace.idFromName(scope.scope);
  const stub = scope.namespace.get(id) as unknown as CloudflareAgentDOIntrospectionRpc;
  const identity =
    scope.truthIdentity ?? cloudflareDefaultTruthIdentityFromRoutingScope(scope.scope);
  return {
    events: (opts) => stub.events(identity, opts),
    streamEvents: (opts) => stub.streamEvents(identity, opts),
    runs: (spec) => stub.runs(spec),
    runTrace: (runId) => stub.runTrace(runId),
    runStatus: (runId) => stub.runStatus(runId),
    quotaState: (spec) => stub.quotaState(spec),
    resourceState: (key) => stub.resourceState(key),
    admissionLease: (key) => stub.admissionLease(key),
  };
};
