import type { WorkspaceEnv } from "./workspace-env-core";
import type { WorkspaceToolExposurePolicy } from "./workspace-binding";
import type { WorkspaceJobDataPlane } from "./workspace-job";

export interface WorkspaceSessionIdentity {
  readonly scope: string;
  readonly runId: string;
  readonly workspaceRef: string;
}

export interface WorkspaceSessionRepoBinding {
  readonly repoRef?: string;
  readonly checkoutRef?: string;
  readonly root?: string;
  readonly inputRef?: string;
  readonly inputHash?: string;
}

export interface WorkspaceSessionPermissionInput {
  /**
   * Product-authored phase label. agentOS preserves it as evidence but does
   * not define product phase vocabulary here.
   */
  readonly phaseRef?: string;
  readonly policy: WorkspaceToolExposurePolicy;
}

export interface WorkspaceSessionResourceLimits {
  readonly maxFileBytes?: number;
  readonly maxCommandChars?: number;
  readonly execTimeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface WorkspaceSessionArtifactReadback {
  readonly readTerminalArtifact: WorkspaceJobDataPlane["readTerminalArtifact"];
}

export type WorkspaceSessionCleanupReason = "completed" | "failed" | "abandoned" | "replaced";

export interface WorkspaceSessionCleanupInput {
  readonly reason?: WorkspaceSessionCleanupReason;
}

export interface WorkspaceSessionLease {
  readonly identity: WorkspaceSessionIdentity;
  readonly env: WorkspaceEnv;
  readonly repo?: WorkspaceSessionRepoBinding;
  readonly permissions?: WorkspaceSessionPermissionInput;
  readonly resourceLimits?: WorkspaceSessionResourceLimits;
  readonly artifactReadback?: WorkspaceSessionArtifactReadback;
  readonly cleanup: (input?: WorkspaceSessionCleanupInput) => Promise<void>;
}

export interface DefineWorkspaceSessionLeaseInput {
  readonly identity: WorkspaceSessionIdentity;
  readonly env: WorkspaceEnv;
  readonly repo?: WorkspaceSessionRepoBinding;
  readonly permissions?: WorkspaceSessionPermissionInput;
  readonly resourceLimits?: WorkspaceSessionResourceLimits;
  readonly artifactReadback?: WorkspaceSessionArtifactReadback;
  readonly cleanup?: WorkspaceSessionLease["cleanup"];
}

export class WorkspaceSessionLifecycleError extends Error {
  override readonly name = "WorkspaceSessionLifecycleError";
}

const requireNonEmpty = (value: string, field: string): string => {
  if (value.length === 0) {
    throw new WorkspaceSessionLifecycleError( // eff-ignore EFF025 reason="defineWorkspaceSessionLease is a synchronous contract factory; remove when the API becomes Effect-returning"
      `workspace session ${field} is required`,
    );
  }
  return value;
};

const finitePositive = (value: number | undefined): number | undefined => {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value <= 0) {
    throw new WorkspaceSessionLifecycleError("workspace session resource limits must be positive"); // eff-ignore EFF025 reason="defineWorkspaceSessionLease is a synchronous contract factory; remove when the API becomes Effect-returning"
  }
  return value;
};

const defaultCleanup = async (): Promise<void> => {};

export const defineWorkspaceSessionLease = (
  input: DefineWorkspaceSessionLeaseInput,
): WorkspaceSessionLease => {
  const identity = Object.freeze({
    scope: requireNonEmpty(input.identity.scope, "scope"),
    runId: requireNonEmpty(input.identity.runId, "runId"),
    workspaceRef: requireNonEmpty(input.identity.workspaceRef, "workspaceRef"),
  });
  const resourceLimits =
    input.resourceLimits === undefined
      ? undefined
      : Object.freeze({
          ...(finitePositive(input.resourceLimits.maxFileBytes) === undefined
            ? {}
            : { maxFileBytes: finitePositive(input.resourceLimits.maxFileBytes) }),
          ...(finitePositive(input.resourceLimits.maxCommandChars) === undefined
            ? {}
            : { maxCommandChars: finitePositive(input.resourceLimits.maxCommandChars) }),
          ...(finitePositive(input.resourceLimits.execTimeoutMs) === undefined
            ? {}
            : { execTimeoutMs: finitePositive(input.resourceLimits.execTimeoutMs) }),
          ...(finitePositive(input.resourceLimits.maxOutputBytes) === undefined
            ? {}
            : { maxOutputBytes: finitePositive(input.resourceLimits.maxOutputBytes) }),
        });
  return Object.freeze({
    identity,
    env: input.env,
    ...(input.repo === undefined ? {} : { repo: Object.freeze({ ...input.repo }) }),
    ...(input.permissions === undefined
      ? {}
      : {
          permissions: Object.freeze({
            ...(input.permissions.phaseRef === undefined
              ? {}
              : { phaseRef: input.permissions.phaseRef }),
            policy: Object.freeze({ ...input.permissions.policy }),
          }),
        }),
    ...(resourceLimits === undefined ? {} : { resourceLimits }),
    ...(input.artifactReadback === undefined ? {} : { artifactReadback: input.artifactReadback }),
    cleanup: input.cleanup ?? defaultCleanup,
  });
};

export const workspaceSessionToolPolicy = (
  session: WorkspaceSessionLease,
): WorkspaceToolExposurePolicy | undefined => session.permissions?.policy;

export const workspaceSessionToolOptions = (
  session: WorkspaceSessionLease,
): WorkspaceToolExposurePolicy & WorkspaceSessionResourceLimits => ({
  ...(session.permissions?.policy ?? {}),
  ...(session.resourceLimits ?? {}),
});

export const readWorkspaceSessionTerminalArtifact = (
  session: WorkspaceSessionLease,
  input: Omit<Parameters<WorkspaceJobDataPlane["readTerminalArtifact"]>[0], "runId">,
): Promise<string | Uint8Array> => {
  if (session.artifactReadback === undefined) {
    return Promise.reject(
      new WorkspaceSessionLifecycleError("workspace session has no artifact readback provider"),
    );
  }
  return session.artifactReadback.readTerminalArtifact({
    ...input,
    runId: session.identity.runId,
  });
};

export const cleanupWorkspaceSessionLease = (
  session: WorkspaceSessionLease,
  input?: WorkspaceSessionCleanupInput,
): Promise<void> => session.cleanup(input);
