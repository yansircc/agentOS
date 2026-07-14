/**
 * In-memory runtime assembly over a backend-neutral capability install graph.
 * @public
 */

import { Effect } from "effect";
import type { Layer } from "effect";
import type { BoundaryContract } from "@agent-os/core/boundary-contract";
import type { LlmTransport } from "@agent-os/core/llm-protocol";
import type { RefResolver, RefResolverService } from "@agent-os/core/ref-resolver";
import type { AgentSubmitBindings } from "@agent-os/core/runtime-protocol";
import { commitBoundaryEvent, type BoundaryCommitIdentity } from "../boundary-commit";
import type { CapabilityContract, CapabilityRuntimeHandle } from "../capability/contract";
import type { HostProfile } from "../capability/host";
import {
  resolveRuntimeInstallGraph,
  type PreflightDiagnostic,
  type ResolveRuntimeInstallGraphOptions,
} from "../capability/resolve";
import { recordLedgerPortEvent, runtimeStorageOrJsonError } from "../ledger";
import {
  RUNTIME_DIAGNOSTIC_FACT_OWNER,
  runtimeDiagnosticBoundaryContract,
} from "../runtime-diagnostic-carrier";
import { InMemoryLlmTransportLive, type InMemoryLlmTransportOptions } from "./llm";
import {
  createInMemoryRuntimeBackend,
  defineResolvedRuntimeInstallGraph,
  type InMemoryRuntimeBackend,
  type InMemoryRuntimeLlmTransportLayer,
  type ResolvedRuntimeInstallGraph,
} from "./runtime-backend";
import { inMemoryConversationTruthIdentity } from "./state-helpers";

/**
 * Terminal execution supplied by the concrete host that exposes the assembled
 * in-memory runtime. The resolver owns no global Effect runtime.
 */
export interface InMemoryRuntimeExecution {
  readonly runPromise: <Success, Failure>(
    effect: Effect.Effect<Success, Failure, never>,
  ) => Promise<Success>;
}

/**
 * In-memory adapter inputs layered over backend-neutral graph resolution.
 */
export interface ResolveRuntimeOptions extends ResolveRuntimeInstallGraphOptions {
  /**
   * Test fixture transport. Real providers should be installed with
   * `llmTransport` plus `refResolver`.
   */
  readonly llm?: InMemoryLlmTransportOptions;
  readonly llmTransport?: Layer.Layer<LlmTransport, never, RefResolverService>;
  readonly refResolver?: RefResolver;
}

/**
 * Successfully assembled in-memory runtime.
 */
export interface ResolvedRuntime {
  readonly layer: InMemoryRuntimeBackend["layer"];
  readonly state: InMemoryRuntimeBackend["state"];
  readonly installGraph: ResolvedRuntimeInstallGraph;
  readonly bindings: AgentSubmitBindings;
  readonly manifest: {
    readonly capabilities: ReadonlyArray<string>;
    readonly host: string;
  };
}

export type ResolveRuntimeResult =
  | { readonly ok: true; readonly resolved: ResolvedRuntime }
  | { readonly ok: false; readonly diagnostics: ReadonlyArray<PreflightDiagnostic> };

/**
 * Resolve a validated capability graph into the in-memory adapter.
 *
 * The caller supplies the terminal executor because the in-memory adapter is a
 * library surface, not a process or framework lifecycle owner.
 *
 * @agentosPrimitive primitive.runtime.resolveRuntime
 * @agentosInvariant invariant.resolve.single-assembly-point
 * @agentosDocs docs/guides/capabilities/resolve-runtime.md
 * @agentosTest packages/runtime/test/capability/resolve.test.ts
 * @public
 */
export const resolveRuntime = (
  host: HostProfile,
  capabilities: ReadonlyArray<CapabilityContract>,
  options: ResolveRuntimeOptions,
  execution: InMemoryRuntimeExecution,
): ResolveRuntimeResult => {
  if (options.llm !== undefined && options.llmTransport !== undefined) {
    return {
      ok: false,
      diagnostics: [
        {
          pass: "config",
          reason:
            "resolveRuntime accepts either test llm fixture options or llmTransport, not both",
        },
      ],
    };
  }
  const graph = resolveRuntimeInstallGraph(host, capabilities, options);
  if (!graph.ok) return graph;

  const truthIdentity = inMemoryConversationTruthIdentity(options.identity);
  let backend: InMemoryRuntimeBackend | undefined;

  const commitBoundaryPayload = (
    owner: string,
    contract: BoundaryContract,
    event: string,
    data: unknown,
    authorityBinding: Parameters<typeof commitBoundaryEvent>[3],
  ): Promise<{ readonly id: number }> =>
    execution
      .runPromise(
        Effect.suspend(() => {
          const runtimeBackend = backend;
          if (runtimeBackend === undefined) {
            return Effect.die(
              new TypeError(`${owner} cannot commit before runtime backend exists`),
            );
          }
          return commitBoundaryEvent(
            contract,
            event,
            data,
            authorityBinding,
            (identity: BoundaryCommitIdentity) =>
              Effect.gen(function* () {
                const events = yield* runtimeBackend.state
                  .commitProtocolEvents([
                    {
                      kind: event,
                      scopeRef: identity.scopeRef ?? truthIdentity.scopeRef,
                      effectAuthorityRef:
                        identity.effectAuthorityRef ?? truthIdentity.effectAuthorityRef,
                      factOwnerRef: identity.factOwnerRef,
                      payload: data,
                    },
                  ])
                  .pipe(
                    Effect.mapError((cause) => runtimeStorageOrJsonError("boundary_event", cause)),
                  );
                return yield* recordLedgerPortEvent("boundary_event", events[0]!);
              }),
          );
        }),
      )
      .then((committed) => ({ id: committed.id }));

  const runtimeDiagnosticHandle: CapabilityRuntimeHandle = {
    commit: ({ event, data }) =>
      commitBoundaryPayload(
        RUNTIME_DIAGNOSTIC_FACT_OWNER,
        runtimeDiagnosticBoundaryContract,
        event,
        data,
        undefined,
      ),
  };
  const capabilityHandles = new Map<string, CapabilityRuntimeHandle>([
    [RUNTIME_DIAGNOSTIC_FACT_OWNER, runtimeDiagnosticHandle],
  ]);
  for (const capability of capabilities) {
    capabilityHandles.set(capability.capabilityId, {
      commit: ({ event, data, authorityBinding }) =>
        commitBoundaryPayload(
          capability.capabilityId,
          capability.carrier.boundaryContract,
          event,
          data,
          authorityBinding,
        ),
    });
  }

  const llmTransport: InMemoryRuntimeLlmTransportLayer =
    options.llmTransport ?? InMemoryLlmTransportLive(options.llm ?? {});
  const installGraph = defineResolvedRuntimeInstallGraph({
    identity: truthIdentity,
    projections: graph.resolved.projections,
    triggers: graph.resolved.triggers,
    handlers: graph.resolved.handlers({ capabilities: capabilityHandles }),
    llmTransport,
    refResolver: options.refResolver,
    graphStatus: {
      handlers: graph.resolved.graphStatus.handlers.values(),
      projections: graph.resolved.graphStatus.projections.values(),
    },
  });
  backend = createInMemoryRuntimeBackend(installGraph);

  return {
    ok: true,
    resolved: {
      layer: backend.layer,
      state: backend.state,
      installGraph,
      bindings: graph.resolved.bindings,
      manifest: graph.resolved.manifest,
    },
  };
};
