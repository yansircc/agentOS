/**
 * Shared test fixtures used by admission/*.test.ts files.
 *
 * Lives next to the split test files so each contract test reaches for
 * the same `makeRuntime` layer composition and the same Chat-Completions
 * shaped stub response (`submitStructuredResp`) without each file rebuilding
 * the runtime by hand. Mirrors the prior monolith's setup block at
 * admission-contract.test.ts:346-385.
 *
 * NOT a test file — vitest ignores _-prefixed files via glob.
 */

import { Context, Layer, ManagedRuntime, Schema } from "effect";

import { EventBusLive } from "../../../src/cloudflare/ledger/event-bus";
import { LedgerLive } from "../../../src/cloudflare/ledger/ledger";
import { CloudflareMaterializedProjectionsLive } from "../../../src/cloudflare/materialized-projections";
import { LlmTransport } from "@agent-os/core/llm-protocol";
import { MaterializedProjectionRegistry } from "@agent-os/runtime";
import { RUNTIME_FACT_OWNER } from "@agent-os/core/runtime-protocol";
import { RefResolverLive } from "@agent-os/core/ref-resolver";
import { QuotaLive } from "../../../src/cloudflare/quota";
import { AdmissionLive } from "../../../src/cloudflare/admission/admission";
import { BoundaryEventsLive } from "../../../src/cloudflare/boundary-events";
import type { EventHandler } from "@agent-os/core/types";
import type { BackendProtocolEventIdentity } from "@agent-os/core/backend-protocol";
import type { AuthorityRef } from "@agent-os/core/effect-claim";
import { structuredToolResp } from "../_stub-ai";

export const SCHEMA = Schema.Struct({ summary: Schema.String });

export const testIdentity = (
  scopeId: string,
  effectAuthorityRef: AuthorityRef = { authorityClass: "effect", authorityId: scopeId },
): BackendProtocolEventIdentity => ({
  scopeRef: { kind: "conversation", scopeId },
  effectAuthorityRef,
  factOwnerRef: RUNTIME_FACT_OWNER,
});

const normalizeIdentity = (
  identityOrScope: string | BackendProtocolEventIdentity,
): BackendProtocolEventIdentity =>
  typeof identityOrScope === "string" ? testIdentity(identityOrScope) : identityOrScope;

export const makeRuntime = (
  state: DurableObjectState,
  llm: Context.Service.Shape<typeof LlmTransport>,
  identityOrScope: string | BackendProtocolEventIdentity,
) => {
  const identity = normalizeIdentity(identityOrScope);
  const handlers = new Map<string, Set<EventHandler>>();
  const eventBus = EventBusLive(handlers);
  const ledger = LedgerLive(state).pipe(Layer.provide(eventBus));
  const boundaryEvents = BoundaryEventsLive(state, identity).pipe(Layer.provide(eventBus));
  const projectionRegistry = Layer.succeed(MaterializedProjectionRegistry, new Map());
  const projections = CloudflareMaterializedProjectionsLive(state).pipe(
    Layer.provide(projectionRegistry),
  );
  const quota = QuotaLive(state, identity).pipe(Layer.provide(eventBus));
  const llmTransport = Layer.succeed(LlmTransport, llm);
  const refs = RefResolverLive({
    material: () => null,
  });
  const admission = AdmissionLive(state, identity).pipe(
    Layer.provide(Layer.mergeAll(eventBus, llmTransport)),
  );
  return ManagedRuntime.make(
    Layer.mergeAll(ledger, boundaryEvents, projections, quota, llmTransport, admission, refs),
  );
};

export const makeRuntimeWithRegistry = (
  state: DurableObjectState,
  llm: Context.Service.Shape<typeof LlmTransport>,
  identityOrScope: string | BackendProtocolEventIdentity,
  endpoints: Record<string, string>,
  credentials: Record<string, string>,
) => {
  const identity = normalizeIdentity(identityOrScope);
  const handlers = new Map<string, Set<EventHandler>>();
  const eventBus = EventBusLive(handlers);
  const ledger = LedgerLive(state).pipe(Layer.provide(eventBus));
  const boundaryEvents = BoundaryEventsLive(state, identity).pipe(Layer.provide(eventBus));
  const projectionRegistry = Layer.succeed(MaterializedProjectionRegistry, new Map());
  const projections = CloudflareMaterializedProjectionsLive(state).pipe(
    Layer.provide(projectionRegistry),
  );
  const quota = QuotaLive(state, identity).pipe(Layer.provide(eventBus));
  const llmTransport = Layer.succeed(LlmTransport, llm);
  const refs = RefResolverLive({
    material: (ref) => {
      switch (ref.kind) {
        case "endpoint":
          return endpoints[ref.ref] ?? null;
        case "credential":
          return credentials[ref.ref] ?? null;
        default:
          return null;
      }
    },
  });
  const admission = AdmissionLive(state, identity).pipe(
    Layer.provide(Layer.mergeAll(eventBus, llmTransport)),
  );
  return ManagedRuntime.make(
    Layer.mergeAll(ledger, boundaryEvents, projections, quota, llmTransport, admission, refs),
  );
};

export const submitStructuredResp = structuredToolResp;
