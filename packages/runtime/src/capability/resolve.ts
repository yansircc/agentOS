/**
 * Resolve runtime - preflighted assembly point for CapabilityContract installs
 * @public
 */

import { Effect, Result, Schema } from "effect";
import type { Layer } from "effect";
import { runPromise as runEffectPromise } from "effect/Effect";
import type { HostProfile, ResolvedHostFacts } from "./host";
import type {
  CapabilityContract,
  CapabilityEventHandlerContext,
  CapabilityInstallation,
  CapabilityRuntimeHandle,
} from "./contract";
import type {
  CapabilityPeerRequirement,
  CapabilityHostFactRequirement,
  HostProvidedFact,
} from "./requirements";
import {
  RUNTIME_DIAGNOSTIC_FACT_OWNER,
  RUNTIME_DIAGNOSTIC_KIND,
  runtimeDiagnosticBoundaryContract,
  runtimeDiagnosticBoundaryModule,
  type RuntimePreflightPass,
  type PreflightDiagnosticSink,
} from "../runtime-diagnostic-carrier";
import {
  createInMemoryRuntimeBackend,
  defineResolvedRuntimeInstallGraph,
  type InMemoryRuntimeLlmTransportLayer,
  type InMemoryRuntimeBackend,
  type ResolvedRuntimeInstallGraph,
} from "../in-memory/runtime-backend";
import { InMemoryLlmTransportLive, type InMemoryLlmTransportOptions } from "../in-memory/llm";
import type { LlmTransport } from "@agent-os/core/llm-protocol";
import type { RefResolver, RefResolverService } from "@agent-os/core/ref-resolver";
import type { AgentBindings, AgentSubmitBindings } from "@agent-os/core/runtime-protocol";
import { validateToolRegistry } from "@agent-os/core/tools";
import {
  extensionManifest,
  validateExtensionDeclarations,
  type ExtensionDeclaration,
} from "@agent-os/core/extensions";
import type { InstalledCapabilityHandle } from "./install-context";
import { commitBoundaryEvent, type BoundaryCommitIdentity } from "../boundary-commit";
import { recordLedgerPortEvent, runtimeStorageOrJsonError } from "../ledger";
import { inMemoryConversationTruthIdentity } from "../in-memory/state-helpers";
import type { BoundaryContract } from "@agent-os/core/boundary-contract";
import { createRuntimeDiagnosticApi } from "./diagnostics";
import type { EventHandler } from "@agent-os/core/types";
import type { AnyMaterializedProjectionDefinition } from "../projection";
import type { AnyDurableTrigger } from "../trigger";
import {
  defineResolvedRuntimeGraphStatus,
  type ResolvedRuntimeGraphRegistration,
  type ResolvedRuntimeGraphStatus,
} from "../runtime-graph-status";
import { allMaterializedHostFactContracts, hasResolvedHostFact } from "./materialized-host-facts";
import { bindDeclaredBoundaryIntents } from "./boundary-modules";

/**
 * Preflight diagnostic returned when resolve fails
 */
export interface PreflightDiagnostic {
  readonly capabilityId?: string;
  readonly pass: RuntimePreflightPass;
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
  /**
   * Test fixture transport. Real providers should be installed with
   * `llmTransport` plus `refResolver`.
   */
  readonly llm?: InMemoryLlmTransportOptions;
  readonly llmTransport?: Layer.Layer<LlmTransport, never, RefResolverService>;
  readonly refResolver?: RefResolver;
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

export interface ResolvedCapabilityEventHandlerFactory {
  readonly eventHandlers: (
    context: CapabilityEventHandlerContext,
  ) => ReadonlyArray<{ readonly kind: string; readonly handler: EventHandler }>;
}

export interface ResolvedCapabilityInstallGraph {
  readonly extensions: ReadonlyArray<ExtensionDeclaration>;
  readonly agentBindings: {
    readonly capabilities?: NonNullable<AgentBindings["capabilities"]>;
  };
  readonly declaredIntents: ReadonlyArray<{
    readonly kind: string;
    readonly boundaryOwnerId: string;
  }>;
  readonly projections: ReadonlyArray<AnyMaterializedProjectionDefinition>;
  readonly triggers: ReadonlyArray<AnyDurableTrigger>;
  readonly handlers: ResolvedCapabilityEventHandlerFactory["eventHandlers"];
  readonly graphStatus: ResolvedRuntimeGraphStatus;
  readonly bindings: AgentSubmitBindings;
  readonly manifest: {
    readonly capabilities: ReadonlyArray<string>;
    readonly host: string;
  };
}

export type ResolveRuntimeInstallGraphResult =
  | { readonly ok: true; readonly resolved: ResolvedCapabilityInstallGraph }
  | { readonly ok: false; readonly diagnostics: ReadonlyArray<PreflightDiagnostic> };

const RUNTIME_DIAGNOSTIC_BOUNDARY_VERSION = "0.1.0";

const describeCause = (cause: unknown): string => {
  if (cause instanceof Error && cause.message.length > 0) return cause.message;
  if (typeof cause === "string" && cause.length > 0) return cause;
  return "unknown failure";
};

const diagnosticDetail = (value: unknown): string => {
  if (typeof value === "string") return value;
  const encoded = syncResult(() => JSON.stringify(value));
  return Result.isSuccess(encoded) && typeof encoded.success === "string"
    ? encoded.success
    : String(value);
};

const syncResult = <Value>(evaluate: () => Value): Result.Result<Value, unknown> =>
  Result.try({
    try: evaluate,
    catch: (cause) => cause,
  });

const isResolvedHostFactsRecord = (value: unknown): value is ResolvedHostFacts =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const promiseResult = <Value>(
  evaluate: () => Value | Promise<Value>,
): Promise<Result.Result<Value, unknown>> =>
  runEffectPromise(
    Effect.result(
      Effect.tryPromise({
        try: () => Promise.resolve(evaluate()),
        catch: (cause) => cause,
      }),
    ),
  );

const emptySubmitBindings = (): AgentSubmitBindings => ({
  tools: {},
  materials: {},
  executionDomains: [],
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

const materializedHostFactDiagnostics = (
  host: HostProfile,
  resolvedHostFacts: ResolvedHostFacts,
): ReadonlyArray<PreflightDiagnostic> => {
  const diagnostics: PreflightDiagnostic[] = [];
  for (const contract of allMaterializedHostFactContracts()) {
    const declared = host.provides.has(contract.fact);
    const materialized = hasResolvedHostFact(resolvedHostFacts, contract.fact);
    if (!declared && !materialized) continue;

    const detail = diagnosticDetail({
      target: host.target,
      fact: contract.fact,
      expected: contract.expected,
    });
    if (!declared) {
      diagnostics.push({
        pass: "host_fact",
        reason: `Host ${host.target} materialized undeclared fact: ${contract.fact}`,
        detail,
      });
      continue;
    }
    if (!materialized) {
      diagnostics.push({
        pass: "host_fact",
        reason: `Host ${host.target} did not materialize declared fact: ${contract.fact}`,
        detail,
      });
      continue;
    }

    const value = resolvedHostFacts[contract.fact];
    if (!contract.accepts(value)) {
      diagnostics.push({
        pass: "host_fact",
        reason: `Host ${host.target} materialized invalid fact: ${contract.fact}`,
        detail: diagnosticDetail({
          target: host.target,
          fact: contract.fact,
          expected: contract.expected,
          actualType: typeof value,
        }),
      });
    }
  }
  return diagnostics;
};

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
      const peerCapability = capMap.get(peer.capabilityId);
      if (peerCapability === undefined) {
        return {
          ok: false,
          diagnostic: {
            pass: "peer_dag",
            capabilityId: cap.capabilityId,
            reason: `Missing required peer capability: ${peer.capabilityId}`,
          },
        };
      }
      if (peer.version !== undefined && peerCapability.version !== peer.version) {
        return {
          ok: false,
          diagnostic: {
            pass: "peer_dag",
            capabilityId: cap.capabilityId,
            reason: `Peer capability ${peer.capabilityId} version mismatch`,
            detail: diagnosticDetail({
              requiredVersion: peer.version,
              installedVersion: peerCapability.version,
            }),
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
 * Execute all preflight passes and resolve capability install graph facts.
 *
 * @agentosInvariant invariant.resolve.single-assembly-point
 * @agentosDocs docs/guides/capabilities/resolve-runtime.md
 * @agentosTest packages/runtime/test/capability/resolve.test.ts
 * @public
 */
const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === "object" &&
  value !== null &&
  "then" in value &&
  typeof (value as { readonly then?: unknown }).then === "function";

export const resolveRuntimeInstallGraph = (
  host: HostProfile,
  capabilities: ReadonlyArray<CapabilityContract>,
  options: Omit<ResolveRuntimeOptions, "llm">,
): ResolveRuntimeInstallGraphResult => {
  const diagnostics: PreflightDiagnostic[] = [];
  const sink = options.diagnosticSink;
  const addDiagnostic = (diag: PreflightDiagnostic) => {
    diagnostics.push(diag);
    if (sink) {
      const commitResult = syncResult(() => {
        const committed = sink.commit(diag);
        if (isThenable(committed)) {
          void Promise.resolve(committed).catch(() => undefined);
          throw new Error("Diagnostic sink commit returned an async result");
        }
        return committed;
      });
      if (Result.isFailure(commitResult)) {
        diagnostics.push({
          pass: "diagnostic_sink",
          reason: "Diagnostic sink commit failed; resolveRuntime fails closed",
          detail: diagnosticDetail({
            failedDiagnostic: diag,
            cause: describeCause(commitResult.failure),
          }),
        });
      }
    }
  };
  const failed = (): ResolveRuntimeInstallGraphResult => ({ ok: false, diagnostics });

  // Pass 1: name uniqueness (capabilityId)
  const capabilityIds = new Set<string>();
  for (const cap of capabilities) {
    if (capabilityIds.has(cap.capabilityId)) {
      addDiagnostic({
        pass: "name_unique",
        capabilityId: cap.capabilityId,
        reason: `Duplicate capabilityId: ${cap.capabilityId}`,
      });
    }
    if (cap.capabilityId !== cap.carrier.ownerId) {
      addDiagnostic({
        pass: "name_unique",
        capabilityId: cap.capabilityId,
        reason: `Capability ${cap.capabilityId} is not owned by carrier ${cap.carrier.ownerId}`,
      });
    }
    if (cap.sourcePackageName !== cap.carrier.sourcePackageName) {
      addDiagnostic({
        pass: "name_unique",
        capabilityId: cap.capabilityId,
        reason: `Capability ${cap.capabilityId} source package does not match carrier owner package`,
        detail: diagnosticDetail({
          capabilitySourcePackageName: cap.sourcePackageName,
          carrierSourcePackageName: cap.carrier.sourcePackageName,
        }),
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
        addDiagnostic({
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
    addDiagnostic(sortResult.diagnostic);
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
          addDiagnostic({
            pass: "config",
            capabilityId: cap.capabilityId,
            reason: `Missing required config key: ${req.key}`,
          });
        }
        continue;
      }
      const decoded = syncResult(() => Schema.decodeUnknownSync(req.schema)(config[req.key]));
      if (Result.isFailure(decoded)) {
        addDiagnostic({
          pass: "config",
          capabilityId: cap.capabilityId,
          reason: `Invalid config key: ${req.key}`,
          detail: describeCause(decoded.failure),
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
        addDiagnostic({
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
  const hostFactsResult = syncResult(() => {
    const materialized = host.materialize({ config, secrets, identity: options.identity });
    if (isThenable(materialized)) {
      throw new Error(`Host ${host.target} materialize returned an async result`);
    }
    if (!isResolvedHostFactsRecord(materialized)) {
      throw new Error(`Host ${host.target} materialize must return a host facts record`);
    }
    return materialized;
  });
  if (Result.isFailure(hostFactsResult)) {
    addDiagnostic({
      pass: "host_fact",
      reason: `Host ${host.target} failed to materialize provided facts`,
      detail: describeCause(hostFactsResult.failure),
    });
  } else {
    resolvedHostFacts = hostFactsResult.success;
  }
  if (diagnostics.length > 0) {
    return failed();
  }
  if (resolvedHostFacts === undefined) {
    addDiagnostic({
      pass: "host_fact",
      reason: `Host ${host.target} did not materialize provided facts`,
    });
    return failed();
  }
  for (const diagnostic of materializedHostFactDiagnostics(host, resolvedHostFacts)) {
    addDiagnostic(diagnostic);
  }
  if (diagnostics.length > 0) {
    return failed();
  }

  // Pass 6: self-diagnostics from capabilities
  for (const cap of capabilities) {
    const capDiags = cap.diagnostics();
    for (const diag of capDiags) {
      addDiagnostic({
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
  const allProjectionRegistrations: ResolvedRuntimeGraphRegistration[] = [];
  const allTriggers: AnyDurableTrigger[] = [];
  const runtimeDiagnosticExtension = runtimeDiagnosticBoundaryModule(
    RUNTIME_DIAGNOSTIC_BOUNDARY_VERSION,
  );
  const allExtensions: ExtensionDeclaration[] = [runtimeDiagnosticExtension];
  const allDeclaredIntents: Array<{
    readonly kind: string;
    readonly boundaryOwnerId: string;
  }> = [];
  const allAgentCapabilities: NonNullable<AgentBindings["capabilities"]> = {};
  const handlerFactories: Array<{
    readonly capabilityId: string;
    readonly register: NonNullable<CapabilityInstallation["eventHandlers"]>;
  }> = [];
  const allHandlerRegistrations: ResolvedRuntimeGraphRegistration[] = [];
  let mergedBindings: AgentSubmitBindings = emptySubmitBindings();

  const handleFor = (cap: CapabilityContract): InstalledCapabilityHandle => ({
    capabilityId: cap.capabilityId,
    commit: () =>
      Promise.reject(new Error(`${cap.capabilityId} cannot commit during install graph assembly`)),
  });

  const globalKeys = new Map<string, string>();
  const addGlobalKey = (axis: string, value: string, capabilityId: string): void => {
    const key = `${axis}:${value}`;
    const previous = globalKeys.get(key);
    if (previous !== undefined) {
      addDiagnostic({
        pass: "global_unique",
        capabilityId,
        reason: `Duplicate ${axis}: ${value}`,
        detail: diagnosticDetail({ firstCapabilityId: previous }),
      });
      return;
    }
    globalKeys.set(key, capabilityId);
  };
  addGlobalKey(
    "extension owner",
    runtimeDiagnosticExtension.manifest.ownerId,
    RUNTIME_DIAGNOSTIC_FACT_OWNER,
  );
  for (const prefix of runtimeDiagnosticExtension.manifest.kindPrefixes) {
    addGlobalKey("extension prefix", prefix, RUNTIME_DIAGNOSTIC_FACT_OWNER);
  }

  for (const cap of sortedCaps) {
    installedCaps.set(cap.capabilityId, handleFor(cap));
    const diagnostics = createRuntimeDiagnosticApi(cap.capabilityId, async () => undefined);
    const installCtx = {
      capabilities: installedCaps,
      host: resolvedHostFacts,
      config,
      secrets,
      diagnostics,
      identity: options.identity,
    };
    let installResult: CapabilityInstallation;
    const installAttempt = syncResult(() => {
      const installed = cap.install(installCtx);
      if (isThenable(installed)) {
        throw new Error(`Capability ${cap.capabilityId} install returned an async result`);
      }
      return installed;
    });
    if (Result.isFailure(installAttempt)) {
      addDiagnostic({
        pass: "install",
        capabilityId: cap.capabilityId,
        reason: `Capability ${cap.capabilityId} install failed`,
        detail: describeCause(installAttempt.failure),
      });
      return failed();
    }
    installResult = installAttempt.success;

    for (const eventKind of Object.values(cap.carrier.kind) as string[]) {
      addGlobalKey("event kind", eventKind, cap.capabilityId);
    }
    for (const projection of installResult.projections ?? []) {
      addGlobalKey("projection kind", projection.kind, cap.capabilityId);
      allProjectionRegistrations.push({
        kind: projection.kind,
        capabilityId: cap.capabilityId,
      });
    }
    for (const trigger of installResult.triggers ?? []) {
      addGlobalKey("trigger kind", trigger.kind, cap.capabilityId);
    }
    for (const intent of installResult.declaredIntents ?? []) {
      addGlobalKey("declared intent", intent.kind, cap.capabilityId);
    }
    for (const extension of installResult.extensions ?? []) {
      const manifest = extensionManifest(extension);
      allExtensions.push(extension);
      addGlobalKey("extension owner", manifest.ownerId, cap.capabilityId);
      for (const prefix of manifest.kindPrefixes) {
        addGlobalKey("extension prefix", prefix, cap.capabilityId);
      }
    }
    for (const bindingRef of Object.keys(installResult.capabilities ?? {})) {
      addGlobalKey("agent capability binding", bindingRef, cap.capabilityId);
    }
    for (const toolName of Object.keys(installResult.bindings?.tools ?? {})) {
      addGlobalKey("tool name", toolName, cap.capabilityId);
    }
    for (const routeName of Object.keys(installResult.bindings?.llmRoutes ?? {})) {
      addGlobalKey("llm route", routeName, cap.capabilityId);
    }
    for (const materialName of Object.keys(installResult.bindings?.materials ?? {})) {
      addGlobalKey("material", materialName, cap.capabilityId);
    }

    // Merge results
    allProjections.push(...(installResult.projections ?? []));
    allTriggers.push(...(installResult.triggers ?? []));
    allDeclaredIntents.push(...(installResult.declaredIntents ?? []));
    Object.assign(allAgentCapabilities, installResult.capabilities ?? {});

    const handlerRegistration = syncResult(
      () => installResult.eventHandlers?.({ capabilities: installedCaps }) ?? [],
    );
    if (Result.isFailure(handlerRegistration)) {
      addDiagnostic({
        pass: "install",
        capabilityId: cap.capabilityId,
        reason: `Capability ${cap.capabilityId} event handler registration failed`,
        detail: describeCause(handlerRegistration.failure),
      });
      return failed();
    }
    for (const registration of handlerRegistration.success) {
      allHandlerRegistrations.push({
        kind: registration.kind,
        capabilityId: cap.capabilityId,
      });
    }
    if (installResult.eventHandlers !== undefined) {
      handlerFactories.push({
        capabilityId: cap.capabilityId,
        register: installResult.eventHandlers,
      });
    }

    if (installResult.bindings) {
      mergedBindings = mergeBindings(mergedBindings, installResult.bindings);
    }
  }
  if (diagnostics.length > 0) {
    return failed();
  }

  const extensionValidation = validateExtensionDeclarations(allExtensions);
  if (!extensionValidation.ok) {
    addDiagnostic({
      pass: "global_unique",
      reason: `Invalid extension namespace: ${extensionValidation.error.kindPrefix}`,
      capabilityId: extensionValidation.error.ownerId,
      detail: diagnosticDetail({ claimedBy: extensionValidation.error.claimedBy }),
    });
    return failed();
  }

  const boundaryIntentBindings = bindDeclaredBoundaryIntents(allExtensions, allDeclaredIntents);
  if (!boundaryIntentBindings.ok) {
    addDiagnostic({
      pass: "global_unique",
      capabilityId: boundaryIntentBindings.intent.boundaryOwnerId,
      reason:
        boundaryIntentBindings.reason === "unbound_boundary_owner"
          ? `Declared intent ${boundaryIntentBindings.intent.kind} references an unbound BoundaryModule`
          : `Declared intent ${boundaryIntentBindings.intent.kind} is outside its BoundaryModule vocabulary`,
    });
    return failed();
  }

  const toolValidation = validateToolRegistry({ ...mergedBindings.tools });
  if (!toolValidation.ok) {
    addDiagnostic({
      pass: "global_unique",
      reason: "Invalid merged tool registry",
      detail: diagnosticDetail(toolValidation.issues),
    });
    return failed();
  }

  return {
    ok: true,
    resolved: {
      extensions: allExtensions,
      agentBindings:
        Object.keys(allAgentCapabilities).length === 0
          ? {}
          : { capabilities: allAgentCapabilities },
      declaredIntents: allDeclaredIntents,
      projections: allProjections,
      triggers: allTriggers,
      handlers: (context) =>
        handlerFactories.flatMap(({ capabilityId, register }) =>
          Array.from(register(context)).map((registration) => ({
            kind: registration.kind,
            handler: async (event) => {
              const handlerResult = await promiseResult(() => registration.handler(event));
              if (Result.isSuccess(handlerResult)) return;
              const runtimeDiagnostic = context.capabilities.get(RUNTIME_DIAGNOSTIC_FACT_OWNER);
              if (runtimeDiagnostic === undefined) {
                throw new Error(
                  "runtime diagnostic capability missing from resolved install graph",
                );
              }
              await runtimeDiagnostic.commit({
                event: RUNTIME_DIAGNOSTIC_KIND.HANDLER_FAILED,
                data: {
                  capabilityId,
                  handler: registration.kind,
                  reason: describeCause(handlerResult.failure),
                  requestedEventId: event.id,
                },
              });
            },
          })),
        ),
      graphStatus: defineResolvedRuntimeGraphStatus({
        handlers: allHandlerRegistrations,
        projections: allProjectionRegistrations,
      }),
      bindings: mergedBindings,
      manifest: {
        capabilities: sortedCaps.map((c) => c.capabilityId),
        host: host.target,
      },
    },
  };
};

/**
 * Execute all preflight passes and resolve an in-memory runtime.
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

  const runtimeDiagnosticHandle: CapabilityRuntimeHandle = {
    commit: ({ event, data }) =>
      commitBoundaryPayload(
        RUNTIME_DIAGNOSTIC_FACT_OWNER,
        runtimeDiagnosticBoundaryContract,
        event,
        data,
      ),
  };
  const capabilityHandles = new Map<string, CapabilityRuntimeHandle>([
    [RUNTIME_DIAGNOSTIC_FACT_OWNER, runtimeDiagnosticHandle],
  ]);
  for (const cap of capabilities) {
    capabilityHandles.set(cap.capabilityId, {
      commit: ({ event, data }) =>
        commitBoundaryPayload(cap.capabilityId, cap.carrier.boundaryContract, event, data),
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
