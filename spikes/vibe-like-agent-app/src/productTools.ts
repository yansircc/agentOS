import { Schema } from "effect";
import {
  defineTool,
  effectfulToolExecution,
  materialRequirement,
  type Tool,
  type ToolAdmitter,
} from "@agent-os/kernel";

const spikeAdmitter =
  <A>(): ToolAdmitter<A> =>
  () => ({ ok: true });

const workspaceMaterial = materialRequirement({
  slot: "workspace",
  kind: "external_resource",
  provider: "cloudflare",
  resourceKind: "sandbox",
});

const deployMaterial = materialRequirement({
  slot: "deploy-target",
  kind: "external_resource",
  provider: "cloudflare",
  resourceKind: "worker",
});

const workspaceExecution = effectfulToolExecution({
  kind: "workspace",
  ref: "vibe-like.workspace",
});

const deployExecution = effectfulToolExecution({
  kind: "remote",
  ref: "vibe-like.deploy",
});

export const boundedShellExecTool = defineTool({
  name: "bounded_shell_exec",
  description: "Run a bounded workspace command and return output refs.",
  args: Schema.Struct({ commandRef: Schema.String, timeoutMs: Schema.Number }),
  execution: workspaceExecution,
  authority: "vibe-like.workspace-tool",
  requiredMaterials: [workspaceMaterial],
  admit: spikeAdmitter(),
  execute: (args) => ({
    exitCode: 0,
    stdoutRef: `stdout:${args.commandRef}`,
    stderrRef: `stderr:${args.commandRef}`,
  }),
});

export const fileListTool = defineTool({
  name: "file_list",
  description: "List workspace files and return an entries ref.",
  args: Schema.Struct({ rootRef: Schema.String }),
  execution: workspaceExecution,
  authority: "vibe-like.workspace-tool",
  requiredMaterials: [workspaceMaterial],
  admit: spikeAdmitter(),
  execute: (args) => ({ entriesRef: `entries:${args.rootRef}` }),
});

export const fileReadTool = defineTool({
  name: "file_read",
  description: "Read a workspace file and return blob metadata.",
  args: Schema.Struct({ path: Schema.String }),
  execution: workspaceExecution,
  authority: "vibe-like.workspace-tool",
  requiredMaterials: [workspaceMaterial],
  admit: spikeAdmitter(),
  execute: (args) => ({ blobRef: `blob:${args.path}`, digest: `sha256:${args.path.length}` }),
});

export const fileWriteTool = defineTool({
  name: "file_write",
  description: "Write a workspace file from a blob ref.",
  args: Schema.Struct({ path: Schema.String, blobRef: Schema.String, digest: Schema.String }),
  execution: workspaceExecution,
  authority: "vibe-like.workspace-tool",
  requiredMaterials: [workspaceMaterial],
  admit: spikeAdmitter(),
  execute: (args) => ({ written: true, blobRef: args.blobRef, digest: args.digest }),
});

export const gitStatusDiffTool = defineTool({
  name: "git_status_diff",
  description: "Return symbolic refs for git status and diff.",
  args: Schema.Struct({ repoRef: Schema.String }),
  execution: workspaceExecution,
  authority: "vibe-like.workspace-tool",
  requiredMaterials: [workspaceMaterial],
  admit: spikeAdmitter(),
  execute: (args) => ({
    statusRef: `git-status:${args.repoRef}`,
    diffRef: `git-diff:${args.repoRef}`,
  }),
});

export const portProbeTool = defineTool({
  name: "port_probe",
  description: "Probe a workspace port.",
  args: Schema.Struct({ port: Schema.Number }),
  execution: workspaceExecution,
  authority: "vibe-like.workspace-tool",
  requiredMaterials: [workspaceMaterial],
  admit: spikeAdmitter(),
  execute: (args) => ({ port: args.port, status: "probing" as const }),
});

export const portOpenTool = defineTool({
  name: "port_open",
  description: "Open a workspace port and return a url ref.",
  args: Schema.Struct({ port: Schema.Number, urlRef: Schema.String }),
  execution: workspaceExecution,
  authority: "vibe-like.workspace-tool",
  requiredMaterials: [workspaceMaterial],
  admit: spikeAdmitter(),
  execute: (args) => ({ port: args.port, status: "open" as const, urlRef: args.urlRef }),
});

export const portCloseTool = defineTool({
  name: "port_close",
  description: "Close a workspace port.",
  args: Schema.Struct({ port: Schema.Number }),
  execution: workspaceExecution,
  authority: "vibe-like.workspace-tool",
  requiredMaterials: [workspaceMaterial],
  admit: spikeAdmitter(),
  execute: (args) => ({ port: args.port, status: "closed" as const }),
});

export const workerDeployReadbackTool = defineTool({
  name: "worker_deploy_readback",
  description: "Deploy a worker bundle and return symbolic deployment refs.",
  args: Schema.Struct({
    appId: Schema.String,
    bundleRef: Schema.String,
    digest: Schema.String,
  }),
  execution: deployExecution,
  authority: "vibe-like.deploy-tool",
  requiredMaterials: [deployMaterial],
  admit: spikeAdmitter(),
  execute: (args) => ({
    deploymentRef: `deployment:${args.appId}`,
    version: "v1",
    digest: args.digest,
    readbackDigest: args.digest,
  }),
});

export const productTools: ReadonlyArray<Tool> = [
  boundedShellExecTool,
  fileListTool,
  fileReadTool,
  fileWriteTool,
  gitStatusDiffTool,
  portProbeTool,
  portOpenTool,
  portCloseTool,
  workerDeployReadbackTool,
];

export const productToolNames = (): ReadonlyArray<string> =>
  productTools.map((tool) => tool.definition.function.name);
