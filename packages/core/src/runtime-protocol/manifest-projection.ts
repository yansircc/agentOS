import type { AgentSchemaSpec } from "@agent-os/core/agent-schema";
import type { AuthorityRef } from "@agent-os/core/effect-claim";
import type { MaterialRef } from "@agent-os/core/material-ref";
import type {
  AgentCapabilityBindingRef,
  AgentDefinitionExtension,
  AgentExecutionDomainRef,
  AgentInstructionsRef,
  AgentInteractionRef,
  AgentLlmRouteBindingRef,
  AgentManifest,
  AgentScopeIdentityPolicy,
  AgentToolBindingRef,
  HandlerKind,
} from "./manifest";

export const AGENT_MANIFEST_PROJECTION_SCHEMA = "agentos.agent_manifest_projection.v1" as const;

export const AGENT_MANIFEST_PROJECTION_TARGETS = ["info", "cli", "docs", "typed_client"] as const;

export type AgentManifestProjectionTarget = (typeof AGENT_MANIFEST_PROJECTION_TARGETS)[number];

export interface AgentManifestProjectionEntry<Value> {
  readonly id: string;
  readonly value: Value;
}

export interface AgentManifestProjectionAgent<K extends HandlerKind = HandlerKind> {
  readonly agentId: string;
  readonly version?: string;
  readonly instructions?: AgentInstructionsRef;
  readonly scope: AgentScopeIdentityPolicy;
  readonly effectAuthorityRef: AuthorityRef;
  readonly handlers: ReadonlyArray<K>;
  readonly extensions?: ReadonlyArray<AgentDefinitionExtension>;
  readonly outputSchema?: AgentSchemaSpec;
}

export interface AgentManifestProjectionBindings {
  readonly llmRoutes: ReadonlyArray<AgentManifestProjectionEntry<AgentLlmRouteBindingRef>>;
  readonly tools: ReadonlyArray<AgentManifestProjectionEntry<AgentToolBindingRef>>;
  readonly capabilities: ReadonlyArray<AgentManifestProjectionEntry<AgentCapabilityBindingRef>>;
  readonly materials: ReadonlyArray<AgentManifestProjectionEntry<MaterialRef>>;
  readonly executionDomains: ReadonlyArray<AgentManifestProjectionEntry<AgentExecutionDomainRef>>;
  readonly interactions: ReadonlyArray<AgentManifestProjectionEntry<AgentInteractionRef>>;
}

export interface AgentManifestProjection<K extends HandlerKind = HandlerKind> {
  readonly schema: typeof AGENT_MANIFEST_PROJECTION_SCHEMA;
  readonly source: {
    readonly kind: "AgentManifest";
    readonly agentId: string;
    readonly version?: string;
  };
  readonly targets: ReadonlyArray<AgentManifestProjectionTarget>;
  readonly agent: AgentManifestProjectionAgent<K>;
  readonly bindings: AgentManifestProjectionBindings;
}

export interface ProjectAgentManifestOptions {
  readonly targets?: ReadonlyArray<AgentManifestProjectionTarget>;
}

const recordEntries = <Value>(
  record: Readonly<Record<string, Value>> | undefined,
): ReadonlyArray<AgentManifestProjectionEntry<Value>> =>
  Object.entries(record ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, value]) => ({ id, value }));

const projectionTargets = (
  targets: ReadonlyArray<AgentManifestProjectionTarget> | undefined,
): ReadonlyArray<AgentManifestProjectionTarget> => {
  const selected = new Set(targets ?? AGENT_MANIFEST_PROJECTION_TARGETS);
  return AGENT_MANIFEST_PROJECTION_TARGETS.filter((target) => selected.has(target));
};

export const projectAgentManifest = <K extends HandlerKind>(
  manifest: AgentManifest<K>,
  options: ProjectAgentManifestOptions = {},
): AgentManifestProjection<K> => {
  const agent: AgentManifestProjectionAgent<K> = {
    agentId: manifest.agentId,
    scope: manifest.scope,
    effectAuthorityRef: manifest.effectAuthorityRef,
    handlers: manifest.handlers,
    ...(manifest.version === undefined ? {} : { version: manifest.version }),
    ...(manifest.instructions === undefined ? {} : { instructions: manifest.instructions }),
    ...(manifest.extensions === undefined ? {} : { extensions: manifest.extensions }),
    ...(manifest.outputSchema === undefined ? {} : { outputSchema: manifest.outputSchema }),
  };
  return {
    schema: AGENT_MANIFEST_PROJECTION_SCHEMA,
    source: {
      kind: "AgentManifest",
      agentId: manifest.agentId,
      ...(manifest.version === undefined ? {} : { version: manifest.version }),
    },
    targets: projectionTargets(options.targets),
    agent,
    bindings: {
      llmRoutes: recordEntries(manifest.llmRoutes),
      tools: recordEntries(manifest.tools),
      capabilities: recordEntries(manifest.capabilities),
      materials: recordEntries(manifest.materials),
      executionDomains: recordEntries(manifest.executionDomains),
      interactions: recordEntries(manifest.interactions),
    },
  };
};
