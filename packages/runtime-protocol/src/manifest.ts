import type { AuthorityRef } from "@agent-os/kernel/effect-claim";
import type { MaterialRef } from "@agent-os/kernel/material-ref";
import type { AgentSchemaSpec } from "@agent-os/kernel/agent-schema";

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

export type AgentScopeKind = "conversation" | "extension" | "tenant" | "workspace";

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
