import { scopeRefKey, type ScopeRef } from "@agent-os/kernel/effect-claim";
import { Option } from "effect";

const workspaceBindingRefBrand: unique symbol = Symbol(
  "@agent-os/runtime-protocol/WorkspaceBindingRef",
);
const providerResourceIdBrand: unique symbol = Symbol(
  "@agent-os/runtime-protocol/ProviderResourceId",
);

export const WORKSPACE_TOPOLOGY = {
  PER_SCOPE: "per_scope",
} as const;

export type WorkspaceTopologyKind = (typeof WORKSPACE_TOPOLOGY)[keyof typeof WORKSPACE_TOPOLOGY];

export interface WorkspaceTopology {
  readonly kind: typeof WORKSPACE_TOPOLOGY.PER_SCOPE;
  readonly allocator: string;
}

export type WorkspaceBindingRef = string & {
  readonly [workspaceBindingRefBrand]: "WorkspaceBindingRef";
};

export type ProviderResourceId = string & {
  readonly [providerResourceIdBrand]: "ProviderResourceId";
};

export interface WorkspaceProviderResourceInput {
  readonly deploymentNamespace: string;
  readonly workspaceBindingRef: WorkspaceBindingRef;
  readonly topology: WorkspaceTopology;
  readonly scopeRef: ScopeRef;
}

export interface WorkspaceProviderResourceIdentity extends WorkspaceProviderResourceInput {
  readonly providerResourceId: ProviderResourceId;
}

const failConstruction = (message: string): never =>
  Option.getOrThrowWith(Option.none(), () => new TypeError(message));

const requireNonEmpty = (label: string, value: string): string => {
  if (typeof value === "string" && value.length > 0) return value;
  return failConstruction(`${label} must be non-empty`);
};

const keyPart = (value: string): string => encodeURIComponent(value).replace(/\./g, "%2E");

export const workspaceBindingRef = (value: string): WorkspaceBindingRef =>
  requireNonEmpty("WorkspaceBindingRef", value) as WorkspaceBindingRef;

export const providerResourceId = (value: string): ProviderResourceId =>
  requireNonEmpty("ProviderResourceId", value) as ProviderResourceId;

export const workspaceProviderResourceId = (
  input: WorkspaceProviderResourceInput,
): ProviderResourceId => {
  const deploymentNamespace = keyPart(
    requireNonEmpty(
      "WorkspaceProviderResourceInput.deploymentNamespace",
      input.deploymentNamespace,
    ),
  );
  const workspace = keyPart(
    requireNonEmpty(
      "WorkspaceProviderResourceInput.workspaceBindingRef",
      input.workspaceBindingRef,
    ),
  );
  const allocator = keyPart(
    requireNonEmpty("WorkspaceProviderResourceInput.topology.allocator", input.topology.allocator),
  );
  return providerResourceId(
    [
      "agentos-provider-resource",
      "workspace",
      "v1",
      deploymentNamespace,
      workspace,
      input.topology.kind,
      allocator,
      keyPart(scopeRefKey(input.scopeRef)),
    ].join(":"),
  );
};

export const workspaceProviderResourceIdentity = (
  input: WorkspaceProviderResourceInput,
): WorkspaceProviderResourceIdentity => ({
  ...input,
  providerResourceId: workspaceProviderResourceId(input),
});
