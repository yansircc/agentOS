import type { AuthorityRef, ScopeRef } from "@agent-os/kernel/effect-claim";
import type { MaterialRef } from "@agent-os/kernel/material-ref";
import type { AgentSchemaSpec } from "@agent-os/kernel/agent-schema";
import type { LedgerTruthIdentity } from "./ledger";

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

export type ManifestScopeRefResult =
  | { readonly ok: true; readonly value: ScopeRef }
  | {
      readonly ok: false;
      readonly reason: "scope_not_manifest_owned" | "stable_scope_id_missing";
      readonly message: string;
    };

/**
 * Non-throwing form of manifest-owned scope projection for compiler surfaces
 * that need to return structured diagnostics instead of exceptions.
 *
 * @public
 */
export const manifestScopeRefResult = (manifest: AgentManifest): ManifestScopeRefResult => {
  const { scope } = manifest;
  if (scope.idSource !== "manifest") {
    return {
      ok: false,
      reason: "scope_not_manifest_owned",
      message: `manifestScopeRef: scope.idSource is "${scope.idSource}", not "manifest"; runtime scope is not manifest-owned`,
    };
  }
  if (scope.stableScopeId === undefined || scope.stableScopeId.length === 0) {
    return {
      ok: false,
      reason: "stable_scope_id_missing",
      message: `manifestScopeRef: scope.idSource="manifest" requires a non-empty stableScopeId`,
    };
  }
  return { ok: true, value: { kind: scope.kind, scopeId: scope.stableScopeId } };
};

/**
 * Derive the kernel {@link ScopeRef} owned by a manifest. Fail-closed: only
 * `idSource: "manifest"` with a non-empty `stableScopeId` has a manifest-owned
 * runtime scope; anything else throws because the scope is not the manifest's to
 * project.
 *
 * @public
 */
export const manifestScopeRef = (manifest: AgentManifest): ScopeRef => {
  const result = manifestScopeRefResult(manifest);
  if (result.ok) return result.value;
  throw new TypeError(result.message);
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
  effectAuthorityRef: manifest.effectAuthorityRef,
});
