import { externalResourceMaterialRef, type MaterialRef } from "@agent-os/kernel/material-ref";
import type { ResolvedMaterial } from "@agent-os/kernel/ref-resolver";
import type { Tool, ToolAdmitter } from "@agent-os/kernel/tools";
import type {
  AgentSubmitBindings,
  SubmitToolContext,
  SubmitToolIntent,
} from "@agent-os/runtime-protocol";
import {
  WORKSPACE_TOOL_SPECS,
  createWorkspaceTools,
  type CreateWorkspaceToolsOptions,
  type WorkspaceEnv,
  type WorkspaceToolName,
} from "@agent-os/workspace-env";

export type WorkspaceToolExposureProfile = "read" | "mutation" | "shell";
export type WorkspaceMutationPolicy = "disabled" | "receipt-backed";
export type WorkspaceShellPolicy = "disabled" | "receipt-backed";

export interface WorkspaceToolExposurePolicy {
  readonly exposure?: ReadonlyArray<WorkspaceToolExposureProfile>;
  readonly mutationPolicy?: WorkspaceMutationPolicy;
  readonly shellPolicy?: WorkspaceShellPolicy;
}

export interface BindWorkspaceToolsForRuntimeOptions extends Omit<
  CreateWorkspaceToolsOptions,
  "admit" | "requiredMaterials"
>, WorkspaceToolExposurePolicy {
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

export const WORKSPACE_TOOL_EXPOSURE_PROFILES: Readonly<
  Record<WorkspaceToolExposureProfile, ReadonlyArray<WorkspaceToolName>>
> = {
  read: ["read_file", "list_files", "glob_files", "grep_files"],
  mutation: ["write_file", "edit_file", "delete_path"],
  shell: ["run_shell"],
};

const workspaceToolNames = new Set(WORKSPACE_TOOL_SPECS.map((spec) => spec.name));

const unique = <A extends string>(values: ReadonlyArray<A>): ReadonlyArray<A> => [
  ...new Set(values),
];

const requireKnownProfile = (profile: WorkspaceToolExposureProfile): WorkspaceToolExposureProfile => {
  if (!(profile in WORKSPACE_TOOL_EXPOSURE_PROFILES)) {
    throw new TypeError(`unknown workspace tool exposure profile: ${profile}`);
  }
  return profile;
};

const selectedWorkspaceToolNames = (
  policy: WorkspaceToolExposurePolicy,
): ReadonlyArray<WorkspaceToolName> => {
  const exposure = unique(policy.exposure ?? ["read"]).map(requireKnownProfile);
  const mutationPolicy = policy.mutationPolicy ?? "disabled";
  const shellPolicy = policy.shellPolicy ?? "disabled";
  if (exposure.includes("mutation") && mutationPolicy === "disabled") {
    throw new TypeError("workspace mutation tools require mutationPolicy: receipt-backed");
  }
  if (exposure.includes("shell") && shellPolicy === "disabled") {
    throw new TypeError("workspace shell tools require shellPolicy: receipt-backed");
  }
  return unique(exposure.flatMap((profile) => WORKSPACE_TOOL_EXPOSURE_PROFILES[profile]));
};

const selectTools = (
  tools: Readonly<Record<WorkspaceToolName, Tool>>,
  names: ReadonlyArray<WorkspaceToolName>,
): Record<string, Tool> => {
  const selected: Record<string, Tool> = {};
  for (const name of names) {
    if (!workspaceToolNames.has(name)) {
      throw new TypeError(`workspace exposure profile references unknown tool: ${name}`);
    }
    const tool = tools[name];
    if (tool === undefined) {
      throw new TypeError(`workspace tool missing from generated registry: ${name}`);
    }
    selected[name] = tool;
  }
  return selected;
};

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
  const selectedNames = selectedWorkspaceToolNames(options);
  const selectedTools = selectTools(tools, selectedNames);
  const exposesRead = selectedNames.some((name) =>
    WORKSPACE_TOOL_EXPOSURE_PROFILES.read.includes(name),
  );
  const exposesWrite = selectedNames.some(
    (name) =>
      WORKSPACE_TOOL_EXPOSURE_PROFILES.mutation.includes(name) ||
      WORKSPACE_TOOL_EXPOSURE_PROFILES.shell.includes(name),
  );

  return {
    tools: selectedTools,
    executionDomains: [
      ...(exposesRead
        ? [{ domain: options.env.domain, replay: { access: "read" as const, witness: "snapshot" as const } }]
        : []),
      ...(exposesWrite
        ? [{ domain: options.env.domain, replay: { access: "write" as const, witness: "receipt" as const } }]
        : []),
    ],
    materials: { workspace },
    resolvedMaterials: { workspace: options.resolvedWorkspace ?? options.env },
    ...(options.toolContext === undefined ? {} : { toolContext: options.toolContext }),
    ...(options.toolIntents === undefined ? {} : { toolIntents: options.toolIntents }),
  };
};
