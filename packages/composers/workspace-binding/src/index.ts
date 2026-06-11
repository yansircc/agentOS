import { Effect, Predicate } from "effect";
import { externalResourceMaterialRef, type MaterialRef } from "@agent-os/kernel/material-ref";
import type { ResolvedMaterial } from "@agent-os/kernel/ref-resolver";
import {
  defineTool,
  withToolWriteRequirement,
  type ExecutionDomain,
  type Tool,
  type ToolAdmitter,
} from "@agent-os/kernel/tools";
import { ToolError } from "@agent-os/kernel/errors";
import type {
  AgentSubmitBindings,
  SubmitToolContext,
  SubmitToolIntent,
} from "@agent-os/runtime-protocol";
import { receiptBackedToolResult, type ReceiptBackedToolResult } from "@agent-os/runtime-protocol";
import {
  WORKSPACE_OP_FACT_OWNER,
  WORKSPACE_OP_KIND,
  WORKSPACE_OP_PROJECTION_KIND,
  workspaceOpBoundaryPackage,
  type WorkspaceOperationProjection,
} from "@agent-os/workspace-op";
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

const WORKSPACE_OP_BOUNDARY_VERSION = "0.2.9";
type WorkspaceWriteToolExecution = {
  readonly kind: "external";
  readonly access: "write";
  readonly domain: ExecutionDomain;
};

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

const isWriteWorkspaceTool = (name: WorkspaceToolName): boolean =>
  WORKSPACE_TOOL_EXPOSURE_PROFILES.mutation.includes(name) ||
  WORKSPACE_TOOL_EXPOSURE_PROFILES.shell.includes(name);

const optionalString = (record: Record<string, unknown>, key: string): string | undefined =>
  typeof record[key] === "string" ? record[key] : undefined;

const optionalNumber = (record: Record<string, unknown>, key: string): number | undefined =>
  typeof record[key] === "number" && Number.isFinite(record[key])
    ? (record[key] as number)
    : undefined;

const optionalBoolean = (record: Record<string, unknown>, key: string): boolean | undefined =>
  typeof record[key] === "boolean" ? record[key] : undefined;

const optionalStringArray = (
  record: Record<string, unknown>,
  key: string,
): ReadonlyArray<string> | undefined =>
  Array.isArray(record[key]) && (record[key] as ReadonlyArray<unknown>).every((value) => typeof value === "string")
    ? (record[key] as ReadonlyArray<string>)
    : undefined;

const workspaceOperationPayload = (
  env: WorkspaceEnv,
  toolName: WorkspaceToolName,
  args: unknown,
  options: Pick<
    BindWorkspaceToolsForRuntimeOptions,
    "maxFileBytes" | "maxCommandChars" | "execTimeoutMs" | "maxOutputBytes"
  >,
): Record<string, unknown> => {
  if (!Predicate.isRecord(args)) {
    throw new TypeError("workspace operation args must be an object");
  }
  const payload: Record<string, unknown> = {
    requestedBy: "@agent-os/workspace-binding",
    workspaceRef: env.domain.ref,
    toolName,
  };
  for (const key of [
    "path",
    "content",
    "oldString",
    "newString",
    "command",
    "cwd",
  ] as const) {
    const value = optionalString(args, key);
    if (value !== undefined) payload[key] = value;
  }
  for (const key of ["expectCount", "timeoutMs"] as const) {
    const value = optionalNumber(args, key);
    if (value !== undefined) payload[key] = value;
  }
  for (const key of ["recursive", "force"] as const) {
    const value = optionalBoolean(args, key);
    if (value !== undefined) payload[key] = value;
  }
  const materialRefs = optionalStringArray(args, "materialRefs");
  if (materialRefs !== undefined) payload.materialRefs = materialRefs;
  if (Array.isArray(args.envRefs)) payload.envRefs = args.envRefs;
  const limits: Record<string, number> = {};
  for (const key of ["maxFileBytes", "maxCommandChars", "execTimeoutMs", "maxOutputBytes"] as const) {
    const value = options[key];
    if (typeof value === "number") limits[key] = value;
  }
  if (Object.keys(limits).length > 0) payload.limits = limits;
  return payload;
};

const receiptBackedWorkspaceTool = (
  tool: Tool,
  name: WorkspaceToolName,
  env: WorkspaceEnv,
  options: Pick<
    BindWorkspaceToolsForRuntimeOptions,
    "maxFileBytes" | "maxCommandChars" | "execTimeoutMs" | "maxOutputBytes"
>,
): Tool =>
{
  if (tool.execution.kind !== "external" || tool.execution.access !== "write") {
    throw new TypeError(`workspace receipt bridge requires external write tool: ${name}`);
  }
  const execution = tool.execution as WorkspaceWriteToolExecution;
  return defineTool<typeof tool.argsSchema.source, ReceiptBackedToolResult, typeof execution>({
    name: tool.definition.function.name,
    description: tool.definition.function.description,
    args: tool.argsSchema.source,
    authority: tool.contract.effectAuthorityRef.authorityClass,
    authorityId: tool.contract.effectAuthorityRef.authorityId,
    ...(tool.contract.effectAuthorityRef.version === undefined
      ? {}
      : { authorityVersion: tool.contract.effectAuthorityRef.version }),
    requiredMaterials: tool.contract.requiredMaterials,
    admit: tool.admit,
    execution,
    ...(tool.quota === undefined ? {} : { quota: tool.quota }),
    execute: (args, ctx) =>
      withToolWriteRequirement(
        Effect.gen(function* () {
          if (ctx.emitIntent === undefined) {
            return yield* new ToolError({
              toolName: name,
              cause: { reason: "workspace_op_missing_emit_intent" },
            });
          }
          if (ctx.awaitProjection === undefined) {
            return yield* new ToolError({
              toolName: name,
              cause: { reason: "workspace_op_missing_await_projection" },
            });
          }
          const emitted = yield* ctx.emitIntent(
            WORKSPACE_OP_KIND.REQUESTED,
            workspaceOperationPayload(env, name, args, options),
          );
          const row = yield* ctx.awaitProjection<WorkspaceOperationProjection>({
            kind: WORKSPACE_OP_PROJECTION_KIND,
            factOwnerRef: WORKSPACE_OP_FACT_OWNER,
            identity: { requestedEventId: emitted.id },
            ready: (candidate) =>
              candidate.state.status === "completed" || candidate.state.status === "rejected",
          });
          if (row.state.status === "rejected") {
            return yield* new ToolError({
              toolName: name,
              cause: {
                reason: row.state.rejected.reason,
                rejectionRef: row.state.rejected.claim.rejectionRef,
              },
            });
          }
          if (row.state.status !== "completed") {
            return yield* new ToolError({
              toolName: name,
              cause: { reason: "workspace_op_projection_not_terminal" },
            });
          }
          if (row.state.completed.claim.anchorRef.anchorKind !== "external_receipt") {
            return yield* new ToolError({
              toolName: name,
              cause: { reason: "workspace_op_completed_without_external_receipt" },
            });
          }
          const receipt = row.state.completed.claim.anchorRef;
          return receiptBackedToolResult({
            result: row.state.result,
            claim: row.state.completed.claim,
            idempotencyKey: row.state.completed.idempotencyKey,
            receipt: receipt as typeof receipt & { readonly anchorKind: "external_receipt" },
          });
        }),
      ),
  });
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
  const receiptBackedToolNames = selectedNames.filter(isWriteWorkspaceTool);
  const runtimeTools = Object.fromEntries(
    Object.entries(selectedTools).map(([name, tool]) => [
      name,
      isWriteWorkspaceTool(name as WorkspaceToolName)
        ? receiptBackedWorkspaceTool(tool, name as WorkspaceToolName, options.env, options)
        : tool,
    ]),
  );
  const exposesRead = selectedNames.some((name) =>
    WORKSPACE_TOOL_EXPOSURE_PROFILES.read.includes(name),
  );
  const exposesWrite = selectedNames.some(
    (name) =>
      WORKSPACE_TOOL_EXPOSURE_PROFILES.mutation.includes(name) ||
      WORKSPACE_TOOL_EXPOSURE_PROFILES.shell.includes(name),
  );

  return {
    tools: runtimeTools,
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
    toolIntents:
      receiptBackedToolNames.length === 0
        ? options.toolIntents
        : [
            ...(options.toolIntents ?? []),
            {
              kind: WORKSPACE_OP_KIND.REQUESTED,
              boundaryPackage: workspaceOpBoundaryPackage(WORKSPACE_OP_BOUNDARY_VERSION),
            },
          ],
    ...(receiptBackedToolNames.length === 0
      ? {}
      : {
          receiptBackedTools: Object.fromEntries(
            receiptBackedToolNames.map((name) => [
              name,
              {
                kind: "intent_projection" as const,
                intentKinds: [WORKSPACE_OP_KIND.REQUESTED],
              },
            ]),
          ),
        }),
  };
};
