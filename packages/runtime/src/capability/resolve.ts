/**
 * Resolve runtime - preflighted assembly point for CapabilityContract installs
 * @public
 */

import { Effect, Schema } from "effect";
import { runPromise as runEffectPromise } from "effect/Effect";
import type { HostProfile, ResolvedHostFacts } from "./host";
import type { CapabilityContract, CapabilityInstallation } from "./contract";
import type {
  CapabilityPeerRequirement,
  CapabilityHostFactRequirement,
  HostProvidedFact,
} from "./requirements";
import {
  RUNTIME_DIAGNOSTIC_FACT_OWNER,
  RUNTIME_DIAGNOSTIC_KIND,
  runtimeDiagnosticBoundaryContract,
  type PreflightDiagnosticSink,
} from "../runtime-diagnostic-carrier";
import {
  createInMemoryRuntimeBackend,
  defineResolvedRuntimeInstallGraph,
  type InMemoryRuntimeBackend,
  type ResolvedRuntimeInstallGraph,
} from "../in-memory/runtime-backend";
import type { InMemoryLlmTransportOptions } from "../in-memory/llm";
import type { AgentSubmitBindings } from "@agent-os/core/runtime-protocol";
import { validateToolRegistry } from "@agent-os/core/tools";
import type { InstalledCapabilityHandle } from "./install-context";
import { commitBoundaryEvent, type BoundaryCommitIdentity } from "../boundary-commit";
import { recordLedgerPortEvent, runtimeStorageOrJsonError } from "../ledger";
import { inMemoryConversationTruthIdentity } from "../in-memory/state-helpers";
import type { BoundaryContract } from "@agent-os/core/boundary-contract";
import { createRuntimeDiagnosticApi } from "./diagnostics";
import type { EventHandler } from "@agent-os/core/types";
import type { AnyMaterializedProjectionDefinition } from "../projection";
import type { AnyDurableTrigger } from "../trigger";

/**
 * Preflight diagnostic returned when resolve fails
 */
export interface PreflightDiagnostic {
  readonly capabilityId?: string;
  readonly pass:
    | "name_unique"
    | "host_fact"
    | "peer_dag"
    | "config"
    | "secret"
    | "self_diagnostic"
    | "global_unique";
  readonly reason: string;
  readonly detail?: string;
}

/**
 * Options for resolveRuntime
 */
export interface ResolveRuntimeOptions {
  readonly config?: Readonly<Record<string, unknown>>;
  readonly secrets?: Readonly<Record<string, string>>;
  readonly identity: string;
  readonly diagnosticSink?: PreflightDiagnosticSink;
  readonly llm?: InMemoryLlmTransportOptions;
}

/**
 * Successful resolve result
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

const describeCause = (cause: unknown): string => {
  if (cause instanceof Error && cause.message.length > 0) return cause.message;
  if (typeof cause === "string" && cause.length > 0) return cause;
  return "unknown handler failure";
};

const diagnosticDetail = (value: unknown): string => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

/**
 * Normalize host fact requirement
 */
const normalizeHostFactRequirement = (
  req: HostProvidedFact | CapabilityHostFactRequirement,
): CapabilityHostFactRequirement =>
  typeof req === "string" ? { fact: req, optional: false } : req;

/**
 * Normalize peer requirement
 */
const normalizePeerRequirement = (
  req: string | CapabilityPeerRequirement,
): CapabilityPeerRequirement =>
  typeof req === "string" ? { capabilityId: req, optional: false } : req;

/**
 * Topologically sort capabilities by peer dependencies
 */
const topologicalSort = (
  capabilities: ReadonlyArray<CapabilityContract>,
):
  | { ok: true; sorted: ReadonlyArray<CapabilityContract> }
  | { ok: false; diagnostic: PreflightDiagnostic } => {
  const capMap = new Map(capabilities.map((c) => [c.capabilityId, c]));
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  // Initialize
  for (const cap of capabilities) {
    inDegree.set(cap.capabilityId, 0);
    adjacency.set(cap.capabilityId, []);
  }

  // Build graph
  for (const cap of capabilities) {
    const peers = (cap.requires.peers ?? []).map(normalizePeerRequirement);
    for (const peer of peers) {
      if (peer.optional) continue;
      if (!capMap.has(peer.capabilityId)) {
        return {
          ok: false,
          diagnostic: {
            pass: "peer_dag",
            capabilityId: cap.capabilityId,
            reason: `Missing required peer capability: ${peer.capabilityId}`,
          },
        };
      }
      adjacency.get(peer.capabilityId)!.push(cap.capabilityId);
      inDegree.set(cap.capabilityId, (inDegree.get(cap.capabilityId) ?? 0) + 1);
    }
  }

  // Kahn's algorithm
  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id);
  }

  const sorted: CapabilityContract[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    const cap = capMap.get(id)!;
    sorted.push(cap);
    for (const dependent of adjacency.get(id) ?? []) {
      inDegree.set(dependent, (inDegree.get(dependent) ?? 1) - 1);
      if (inDegree.get(dependent) === 0) {
        queue.push(dependent);
      }
    }
  }

  if (sorted.length !== capabilities.length) {
    return {
      ok: false,
      diagnostic: {
        pass: "peer_dag",
        reason: "Circular dependency detected in capability peer graph",
      },
    };
  }

  return { ok: true, sorted };
};

/**
 * Execute all preflight passes and resolve runtime
 *
 * @agentosPrimitive primitive.runtime.resolveRuntime
 * @agentosInvariant invariant.resolve.single-assembly-point
 * @agentosDocs docs/guides/capabilities/resolve-runtime.md
 * @agentosTest packages/runtime/test/capability/resolve.test.ts
 * @public
 */
export const resolveRuntime = async (
  host: HostProfile,
  capabilities: ReadonlyArray<CapabilityContract>,
  options: ResolveRuntimeOptions,
): Promise<ResolveRuntimeResult> => {
  const diagnostics: PreflightDiagnostic[] = [];
  const sink = options.diagnosticSink;
  const addDiagnostic = async (diag: PreflightDiagnostic) => {
    diagnostics.push(diag);
    if (sink) {
      await sink.commit(diag);
    }
  };
  const failed = (): ResolveRuntimeResult => ({ ok: false, diagnostics });

  // Pass 1: name uniqueness (capabilityId)
  const capabilityIds = new Set<string>();
  for (const cap of capabilities) {
    if (capabilityIds.has(cap.capabilityId)) {
      await addDiagnostic({
        pass: "name_unique",
        capabilityId: cap.capabilityId,
        reason: `Duplicate capabilityId: ${cap.capabilityId}`,
      });
    }
    capabilityIds.add(cap.capabilityId);
  }
  if (diagnostics.length > 0) {
    return failed();
  }

  // Pass 2: host fact requirements
  for (const cap of capabilities) {
    const hostFacts = (cap.requires.hostFacts ?? []).map(normalizeHostFactRequirement);
    for (const req of hostFacts) {
      if (req.optional) continue;
      if (!host.provides.has(req.fact)) {
        await addDiagnostic({
          pass: "host_fact",
          capabilityId: cap.capabilityId,
          reason: `Host ${host.target} missing required fact: ${req.fact}`,
        });
      }
    }
  }
  if (diagnostics.length > 0) {
    return failed();
  }

  // Pass 3: peer DAG sort + dependency check
  const sortResult = topologicalSort(capabilities);
  if (!sortResult.ok) {
    await addDiagnostic(sortResult.diagnostic);
    return failed();
  }
  const sortedCaps = sortResult.sorted;

  // Pass 4: config validation
  const config = { ...options.config };
  for (const cap of capabilities) {
    const configReqs = cap.requires.config ?? [];
    for (const req of configReqs) {
      if (!(req.key in config)) {
        if (req.optional && req.default !== undefined) {
          config[req.key] = req.default;
          continue;
        }
        if (!req.optional) {
          await addDiagnostic({
            pass: "config",
            capabilityId: cap.capabilityId,
            reason: `Missing required config key: ${req.key}`,
          });
        }
        continue;
      }
      try {
        Schema.decodeUnknownSync(req.schema)(config[req.key]);
      } catch (cause) {
        await addDiagnostic({
          pass: "config",
          capabilityId: cap.capabilityId,
          reason: `Invalid config key: ${req.key}`,
          detail: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
  }
  if (diagnostics.length > 0) {
    return failed();
  }

  // Pass 5: secret validation
  const secrets = options.secrets ?? {};
  for (const cap of capabilities) {
    const secretReqs = cap.requires.secrets ?? [];
    for (const req of secretReqs) {
      const key = typeof req === "string" ? req : req.key;
      const optional = typeof req === "string" ? false : req.optional;
      if (!(key in secrets) && !optional) {
        await addDiagnostic({
          pass: "secret",
          capabilityId: cap.capabilityId,
          reason: `Missing required secret: ${key}`,
        });
      }
    }
  }
  if (diagnostics.length > 0) {
    return failed();
  }

  let resolvedHostFacts: ResolvedHostFacts | undefined;
  try {
    resolvedHostFacts = await host.materialize({ config, secrets, identity: options.identity });
  } catch (cause) {
    await addDiagnostic({
      pass: "host_fact",
      reason: `Host ${host.target} failed to materialize provided facts`,
      detail: cause instanceof Error ? cause.message : String(cause),
    });
  }
  if (diagnostics.length > 0) {
    return failed();
  }
  if (resolvedHostFacts === undefined) {
    await addDiagnostic({
      pass: "host_fact",
      reason: `Host ${host.target} did not materialize provided facts`,
    });
    return failed();
  }

  // Pass 6: self-diagnostics from capabilities
  for (const cap of capabilities) {
    const capDiags = cap.diagnostics();
    for (const diag of capDiags) {
      await addDiagnostic({
        ...diag,
        pass: "self_diagnostic",
      });
    }
  }
  if (diagnostics.length > 0) {
    return failed();
  }

  // Install capabilities in topological order
  const installedCaps = new Map<string, InstalledCapabilityHandle>();
  const allProjections: AnyMaterializedProjectionDefinition[] = [];
  const allTriggers: AnyDurableTrigger[] = [];
  const allEventHandlers: Array<{ readonly kind: string; readonly handler: EventHandler }> = [];
  let mergedBindings: AgentSubmitBindings = { tools: {}, materials: {}, executionDomains: [] };
  const truthIdentity = inMemoryConversationTruthIdentity(options.identity);
  let backend: InMemoryRuntimeBackend | undefined;

  const commitBoundaryPayload = async (
    owner: string,
    contract: BoundaryContract,
    event: string,
    data: unknown,
  ): Promise<{ readonly id: number }> => {
    const runtimeBackend = backend;
    if (runtimeBackend === undefined) {
      throw new Error(`${owner} cannot commit before runtime backend exists`);
    }
    const committed = await runEffectPromise(
      commitBoundaryEvent(contract, event, data, (identity: BoundaryCommitIdentity) =>
        Effect.gen(function* () {
          const events = yield* runtimeBackend.state
            .commitProtocolEvents([
              {
                kind: event,
                scopeRef: identity.scopeRef ?? truthIdentity.scopeRef,
                effectAuthorityRef: identity.effectAuthorityRef ?? truthIdentity.effectAuthorityRef,
                factOwnerRef: identity.factOwnerRef,
                payload: data,
              },
            ])
            .pipe(Effect.mapError((cause) => runtimeStorageOrJsonError("boundary_event", cause)));
          return yield* recordLedgerPortEvent("boundary_event", events[0]!);
        }),
      ),
    );
    return { id: committed.id };
  };

  const commitRuntimeDiagnostic = (
    event: string,
    data: unknown,
  ): Promise<{ readonly id: number }> =>
    commitBoundaryPayload(
      RUNTIME_DIAGNOSTIC_FACT_OWNER,
      runtimeDiagnosticBoundaryContract,
      event,
      data,
    );

  const handleFor = (cap: CapabilityContract): InstalledCapabilityHandle => ({
    capabilityId: cap.capabilityId,
    commit: ({ event, data }) =>
      commitBoundaryPayload(cap.capabilityId, cap.carrier.boundaryContract, event, data),
  });

  const mergeBindings = (
    left: AgentSubmitBindings,
    right: AgentSubmitBindings,
  ): AgentSubmitBindings => ({
    ...left,
    ...right,
    llmRoutes: { ...left.llmRoutes, ...right.llmRoutes },
    tools: { ...left.tools, ...right.tools },
    materials: { ...left.materials, ...right.materials },
    executionDomains: [...(left.executionDomains ?? []), ...(right.executionDomains ?? [])],
    toolContext:
      left.toolContext === undefined && right.toolContext === undefined
        ? undefined
        : {
            extensions: {
              ...left.toolContext?.extensions,
              ...right.toolContext?.extensions,
            },
          },
    toolIntents: [...(left.toolIntents ?? []), ...(right.toolIntents ?? [])],
    receiptBackedTools: {
      ...left.receiptBackedTools,
      ...right.receiptBackedTools,
    },
    decisionInterrupts: [...(left.decisionInterrupts ?? []), ...(right.decisionInterrupts ?? [])],
    ...(right.executionIdentity === undefined
      ? left.executionIdentity === undefined
        ? {}
        : { executionIdentity: left.executionIdentity }
      : { executionIdentity: right.executionIdentity }),
  });

  const globalKeys = new Map<string, string>();
  const addGlobalKey = async (axis: string, value: string, capabilityId: string): Promise<void> => {
    const key = `${axis}:${value}`;
    const previous = globalKeys.get(key);
    if (previous !== undefined) {
      await addDiagnostic({
        pass: "global_unique",
        capabilityId,
        reason: `Duplicate ${axis}: ${value}`,
        detail: diagnosticDetail({ firstCapabilityId: previous }),
      });
      return;
    }
    globalKeys.set(key, capabilityId);
  };

  for (const cap of sortedCaps) {
    installedCaps.set(cap.capabilityId, handleFor(cap));
    const diagnostics = createRuntimeDiagnosticApi(cap.capabilityId, (_contract, event, payload) =>
      commitRuntimeDiagnostic(event, payload),
    );
    const installCtx = {
      capabilities: installedCaps,
      host: resolvedHostFacts,
      config,
      secrets,
      diagnostics,
      identity: options.identity,
    };
    const installResult: CapabilityInstallation = await cap.install(installCtx);

    for (const eventKind of Object.values(cap.carrier.kind) as string[]) {
      await addGlobalKey("event kind", eventKind, cap.capabilityId);
    }
    for (const projection of installResult.projections ?? []) {
      await addGlobalKey("projection kind", projection.kind, cap.capabilityId);
    }
    for (const trigger of installResult.triggers ?? []) {
      await addGlobalKey("trigger kind", trigger.kind, cap.capabilityId);
    }
    for (const intent of installResult.declaredIntents ?? []) {
      await addGlobalKey("declared intent", intent.kind, cap.capabilityId);
    }
    for (const extension of installResult.extensions ?? []) {
      await addGlobalKey("extension owner", extension.ownerId, cap.capabilityId);
      for (const prefix of extension.kindPrefixes) {
        await addGlobalKey("extension prefix", prefix, cap.capabilityId);
      }
    }
    for (const toolName of Object.keys(installResult.bindings?.tools ?? {})) {
      await addGlobalKey("tool name", toolName, cap.capabilityId);
    }
    for (const routeName of Object.keys(installResult.bindings?.llmRoutes ?? {})) {
      await addGlobalKey("llm route", routeName, cap.capabilityId);
    }
    for (const materialName of Object.keys(installResult.bindings?.materials ?? {})) {
      await addGlobalKey("material", materialName, cap.capabilityId);
    }

    // Merge results
    allProjections.push(...(installResult.projections ?? []));
    allTriggers.push(...(installResult.triggers ?? []));

    const handlers = installResult.eventHandlers?.(installCtx) ?? [];
    for (const registration of handlers) {
      allEventHandlers.push({
        kind: registration.kind,
        handler: async (event) => {
          try {
            await registration.handler(event);
          } catch (cause) {
            await commitRuntimeDiagnostic(RUNTIME_DIAGNOSTIC_KIND.HANDLER_FAILED, {
              capabilityId: cap.capabilityId,
              handler: registration.kind,
              reason: describeCause(cause),
              requestedEventId: event.id,
            });
          }
        },
      });
    }

    if (installResult.bindings) {
      mergedBindings = mergeBindings(mergedBindings, installResult.bindings);
    }
  }
  if (diagnostics.length > 0) {
    return failed();
  }

  const toolValidation = validateToolRegistry({ ...mergedBindings.tools });
  if (!toolValidation.ok) {
    await addDiagnostic({
      pass: "global_unique",
      reason: "Invalid merged tool registry",
      detail: diagnosticDetail(toolValidation.issues),
    });
    return failed();
  }

  const installGraph = defineResolvedRuntimeInstallGraph({
    identity: truthIdentity,
    projections: allProjections,
    triggers: allTriggers,
    handlers: allEventHandlers,
    llm: options.llm ?? {},
  });
  backend = createInMemoryRuntimeBackend(installGraph);

  return {
    ok: true,
    resolved: {
      layer: backend.layer,
      state: backend.state,
      installGraph,
      bindings: mergedBindings,
      manifest: {
        capabilities: sortedCaps.map((c) => c.capabilityId),
        host: host.target,
      },
    },
  };
};
