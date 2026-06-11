import { externalResourceMaterialRef, type MaterialRef } from "@agent-os/kernel/material-ref";
import type { ResolvedMaterial } from "@agent-os/kernel/ref-resolver";
import type { ToolAdmitter } from "@agent-os/kernel/tools";
import type {
  AgentSubmitBindings,
  SubmitToolContext,
  SubmitToolIntent,
} from "@agent-os/runtime-protocol";
import {
  createWorkspaceTools,
  type CreateWorkspaceToolsOptions,
  type WorkspaceEnv,
} from "@agent-os/workspace-env";

export interface BindWorkspaceToolsForRuntimeOptions extends Omit<
  CreateWorkspaceToolsOptions,
  "admit" | "requiredMaterials"
> {
  readonly env: WorkspaceEnv;
  readonly admit: ToolAdmitter<unknown>;
  readonly workspaceMaterialRef?: MaterialRef;
  readonly resolvedWorkspace?: ResolvedMaterial;
  readonly toolContext?: SubmitToolContext;
  readonly toolIntents?: ReadonlyArray<SubmitToolIntent>;
}

export const workspaceEnvMaterialRef = (env: WorkspaceEnv): MaterialRef =>
  externalResourceMaterialRef({
    provider: "agent-os",
    resourceKind: "workspace-env",
    ref: env.domain.ref,
  });

/**
 * Binds standard workspace tools and their workspace material for one submit.
 *
 * This helper does not execute external tools. Runtime still requires a
 * receipt/dispatch-backed path for external workspace mutation.
 */
export const bindWorkspaceToolsForRuntime = (
  options: BindWorkspaceToolsForRuntimeOptions,
): AgentSubmitBindings => {
  const workspace = options.workspaceMaterialRef ?? workspaceEnvMaterialRef(options.env);
  const tools = createWorkspaceTools(options.env, {
    authority: options.authority,
    admit: options.admit,
    ...(options.authorityId === undefined ? {} : { authorityId: options.authorityId }),
    ...(options.authorityVersion === undefined
      ? {}
      : { authorityVersion: options.authorityVersion }),
    ...(options.maxFileBytes === undefined ? {} : { maxFileBytes: options.maxFileBytes }),
    ...(options.maxCommandChars === undefined ? {} : { maxCommandChars: options.maxCommandChars }),
    ...(options.execTimeoutMs === undefined ? {} : { execTimeoutMs: options.execTimeoutMs }),
    ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
  });

  return {
    tools,
    materials: { workspace },
    resolvedMaterials: { workspace: options.resolvedWorkspace ?? options.env },
    ...(options.toolContext === undefined ? {} : { toolContext: options.toolContext }),
    ...(options.toolIntents === undefined ? {} : { toolIntents: options.toolIntents }),
  };
};
