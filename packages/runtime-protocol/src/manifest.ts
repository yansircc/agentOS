import type { AuthorityRef, ScopeRef } from "@agent-os/kernel/effect-claim";
import type { MaterialRef } from "@agent-os/kernel/material-ref";
import type { AgentSchemaSpec } from "@agent-os/kernel/agent-schema";
import type { LedgerTruthIdentity } from "./ledger";

export const AGENT_MANIFEST_IDENTITY_VERSION = "agent-manifest-identity-v1" as const;

export const AGENT_MANIFEST_IDENTITY_FACET_KINDS = [
  "deployment",
  "adapter",
  "codec",
  "schema",
  "provider_strategy",
] as const;

export type AgentManifestIdentityFacetKind = (typeof AGENT_MANIFEST_IDENTITY_FACET_KINDS)[number];

export interface AgentManifestIdentityFacet {
  readonly kind: AgentManifestIdentityFacetKind;
  readonly key: string;
  readonly digest: string;
}

export const BUILTIN_HANDLER_KINDS = [
  "user_message",
  "tool_called",
  "decision_resumed",
  "scheduled",
] as const;

export type BuiltinHandlerKind = (typeof BUILTIN_HANDLER_KINDS)[number];
export type ExtensionHandlerKind<
  ExtensionId extends string = string,
  Kind extends string = string,
> = `${ExtensionId}.${Kind}`;
export type HandlerKind = BuiltinHandlerKind | ExtensionHandlerKind;

/**
 * Authored scope identity uses the kernel {@link ScopeRef} vocabulary directly,
 * so there is one scope vocabulary instead of an authoring/runtime bridge.
 * `external` is excluded because it needs a `systemRef` that a `stableScopeId`
 * cannot carry.
 */
export type AgentScopeKind = Exclude<ScopeRef["kind"], "external">;

export interface AgentScopeIdentityPolicy {
  readonly kind: AgentScopeKind;
  readonly idSource: "submit_scope" | "manifest" | "extension";
  readonly stableScopeId?: string;
}

export interface AgentLlmRouteBindingRef {
  readonly bindingRef: string;
}

export interface AgentToolBindingRef {
  readonly bindingRef: string;
  readonly executionDomain?: string;
  readonly interaction?: string;
  readonly materialRefs?: ReadonlyArray<string>;
  readonly effects?: ReadonlyArray<string>;
  readonly receiptPolicy?: string;
}

export interface AgentCapabilityBindingRef {
  readonly bindingRef: string;
}

export interface AgentInstructionsRef {
  readonly path: string;
  readonly digest: string;
}

export interface AgentExecutionDomainRef {
  readonly bindingRef: string;
}

export interface AgentInteractionRef {
  readonly bindingRef: string;
}

export interface AgentDefinitionExtension<K extends ExtensionHandlerKind = ExtensionHandlerKind> {
  readonly extensionId: string;
  readonly handlerKinds: ReadonlyArray<K>;
}

export interface AgentManifest<K extends HandlerKind = HandlerKind> {
  readonly agentId: string;
  readonly version?: string;
  readonly instructions?: AgentInstructionsRef;
  readonly scope: AgentScopeIdentityPolicy;
  readonly effectAuthorityRef: AuthorityRef;
  readonly handlers: ReadonlyArray<K>;
  readonly extensions?: ReadonlyArray<AgentDefinitionExtension>;
  readonly identityFacets?: ReadonlyArray<AgentManifestIdentityFacet>;
  readonly llmRoutes?: Readonly<Record<string, AgentLlmRouteBindingRef>>;
  readonly tools?: Readonly<Record<string, AgentToolBindingRef>>;
  readonly capabilities?: Readonly<Record<string, AgentCapabilityBindingRef>>;
  readonly materials?: Readonly<Record<string, MaterialRef>>;
  readonly executionDomains?: Readonly<Record<string, AgentExecutionDomainRef>>;
  readonly interactions?: Readonly<Record<string, AgentInteractionRef>>;
  readonly outputSchema?: AgentSchemaSpec;
}

export type AgentManifestInput<Kinds extends readonly HandlerKind[]> = Omit<
  AgentManifest<Kinds[number]>,
  "handlers"
> & {
  readonly handlers: Kinds;
};

export const defineAgentManifest = <const Kinds extends readonly HandlerKind[]>(
  manifest: AgentManifestInput<Kinds>,
): AgentManifest<Kinds[number]> => manifest;

/**
 * Derive the kernel {@link ScopeRef} owned by a manifest. Fail-closed: only
 * `idSource: "manifest"` with a non-empty `stableScopeId` has a manifest-owned
 * runtime scope; anything else throws because the scope is not the manifest's to
 * project.
 *
 * @public
 */
export const manifestScopeRef = (manifest: AgentManifest): ScopeRef => {
  const { scope } = manifest;
  if (scope.idSource !== "manifest") {
    throw new TypeError(
      `manifestScopeRef: scope.idSource is "${scope.idSource}", not "manifest"; runtime scope is not manifest-owned`,
    );
  }
  if (scope.stableScopeId === undefined || scope.stableScopeId.length === 0) {
    throw new TypeError(
      `manifestScopeRef: scope.idSource="manifest" requires a non-empty stableScopeId`,
    );
  }
  return { kind: scope.kind, scopeId: scope.stableScopeId };
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isAgentManifestIdentityFacetKind = (
  value: unknown,
): value is AgentManifestIdentityFacetKind =>
  typeof value === "string" &&
  AGENT_MANIFEST_IDENTITY_FACET_KINDS.includes(value as AgentManifestIdentityFacetKind);

const encodeIdentityPart = (value: string): string =>
  encodeURIComponent(value).replace(/\./g, "%2E");

const identityFacetKey = (facet: AgentManifestIdentityFacet): string =>
  `${facet.kind}\u0000${facet.key}`;

const validateIdentityFacet = (facet: AgentManifestIdentityFacet, index: number): void => {
  if (!isAgentManifestIdentityFacetKind(facet.kind)) {
    throw new TypeError(`manifestTruthIdentity: identityFacets[${index}].kind is invalid`);
  }
  if (!isNonEmptyString(facet.key)) {
    throw new TypeError(`manifestTruthIdentity: identityFacets[${index}].key must be non-empty`);
  }
  if (!isNonEmptyString(facet.digest)) {
    throw new TypeError(`manifestTruthIdentity: identityFacets[${index}].digest must be non-empty`);
  }
};

const manifestIdentityFacets = (
  manifest: AgentManifest,
): ReadonlyArray<AgentManifestIdentityFacet> => [
  ...(manifest.identityFacets ?? []),
  ...(manifest.outputSchema === undefined
    ? []
    : [
        {
          kind: "schema" as const,
          key: "output",
          digest: manifest.outputSchema.fingerprint,
        },
      ]),
];

const canonicalManifestIdentityFacets = (
  manifest: AgentManifest,
): ReadonlyArray<AgentManifestIdentityFacet> => {
  const seen = new Map<string, AgentManifestIdentityFacet>();
  const facets = manifestIdentityFacets(manifest);
  facets.forEach((facet, index) => {
    validateIdentityFacet(facet, index);
    const key = identityFacetKey(facet);
    if (seen.has(key)) {
      throw new TypeError(
        `manifestTruthIdentity: duplicate identity facet ${facet.kind}:${facet.key}`,
      );
    }
    seen.set(key, facet);
  });
  return [...facets].sort((left, right) => {
    const byKind = left.kind.localeCompare(right.kind);
    if (byKind !== 0) return byKind;
    return left.key.localeCompare(right.key);
  });
};

const manifestIdentityAuthorityRef = (manifest: AgentManifest): AuthorityRef => {
  const facets = canonicalManifestIdentityFacets(manifest);
  if (facets.length === 0) return manifest.effectAuthorityRef;

  const baseVersion =
    manifest.effectAuthorityRef.version === undefined
      ? "base=none"
      : `base=some:${encodeIdentityPart(manifest.effectAuthorityRef.version)}`;
  const facetParts = facets.map(
    (facet) =>
      `facet=${encodeIdentityPart(facet.kind)}:${encodeIdentityPart(facet.key)}:${encodeIdentityPart(
        facet.digest,
      )}`,
  );

  return {
    ...manifest.effectAuthorityRef,
    version: [AGENT_MANIFEST_IDENTITY_VERSION, baseVersion, ...facetParts].join("|"),
  };
};

/**
 * Single-source the runtime truth identity from a compiled manifest so a
 * consumer never hand-builds `{ scopeRef, effectAuthorityRef }`. The runtime
 * ledger injects `factOwnerRef`; consumers that need a full event identity add
 * it through the backend, not by hand.
 *
 * @public
 */
export const manifestTruthIdentity = (manifest: AgentManifest): LedgerTruthIdentity => ({
  scopeRef: manifestScopeRef(manifest),
  effectAuthorityRef: manifestIdentityAuthorityRef(manifest),
});
