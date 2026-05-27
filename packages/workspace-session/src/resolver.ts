import type { ScopeRef } from "@agent-os/core/effect-claim";
import {
  resolveStatefulSessionRoot,
  type RuntimeScopeKind,
} from "@agent-os/core/runtime-scope";

export interface WorkspaceSessionResolutionSpec {
  readonly carrierRef: string;
}

export type WorkspaceSessionResolution =
  | {
      readonly ok: true;
      readonly scopeRef: Extract<ScopeRef, { readonly kind: "session" }>;
      readonly carrierRef: string;
      readonly sessionRootRef: string;
      readonly workspaceRootRef: string;
      readonly backupRootRef: string;
      readonly previewRootRef: string;
      readonly cleanupRef: string;
    }
  | {
      readonly ok: false;
      readonly reason: "scope_kind_is_not_session";
      readonly kind: RuntimeScopeKind;
    };

export const resolveWorkspaceSession = (
  scopeRef: ScopeRef,
  spec: WorkspaceSessionResolutionSpec,
): WorkspaceSessionResolution => {
  const root = resolveStatefulSessionRoot(scopeRef, spec.carrierRef);
  if (!root.ok) {
    return root;
  }

  return {
    ok: true,
    scopeRef: scopeRef as Extract<ScopeRef, { readonly kind: "session" }>,
    carrierRef: spec.carrierRef,
    sessionRootRef: root.stateRoot,
    workspaceRootRef: `${root.stateRoot}/workspace`,
    backupRootRef: `${root.stateRoot}/backups`,
    previewRootRef: `${root.stateRoot}/previews`,
    cleanupRef: root.cleanupRef,
  };
};
