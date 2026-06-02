import type { Effect } from "effect";
import type { PreClaim, RejectedClaim } from "@agent-os/kernel/effect-claim";

import type {
  WorkspaceSessionBackedUpPayload,
  WorkspaceSessionDestroyedPayload,
  WorkspaceSessionFailedPayload,
  WorkspaceSessionLifecycleStep,
  WorkspaceSessionPreviewAllocatedPayload,
  WorkspaceSessionRestoredPayload,
  WorkspaceSessionRetention,
  WorkspaceSessionStartedPayload,
} from "./events";

export interface WorkspaceSessionStartRequest {
  readonly claim: PreClaim;
  readonly subjectRef: string;
  readonly retention?: WorkspaceSessionRetention;
  readonly templateRef?: string;
}

export interface WorkspaceSessionRestoreRequest {
  readonly claim: PreClaim;
  readonly subjectRef: string;
  readonly backupRef: string;
  readonly retention?: WorkspaceSessionRetention;
}

export interface WorkspaceSessionBackupRequest {
  readonly claim: PreClaim;
  readonly subjectRef: string;
  readonly sessionRef: string;
  readonly expiresAt?: string;
}

export interface WorkspaceSessionPreviewRequest {
  readonly claim: PreClaim;
  readonly subjectRef: string;
  readonly sessionRef: string;
  readonly port: number;
  readonly protocol?: "http" | "https";
}

export interface WorkspaceSessionDestroyRequest {
  readonly claim: PreClaim;
  readonly subjectRef: string;
  readonly sessionRef: string;
  readonly reason: WorkspaceSessionDestroyedPayload["reason"];
}

export interface WorkspaceSessionExecRequest {
  readonly sessionRef: string;
  readonly cwd: string;
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly timeoutMs: number;
  readonly maxOutputBytes?: number;
  readonly envRefs?: Readonly<Record<string, string>>;
  readonly materialRefs?: ReadonlyArray<string>;
}

export interface WorkspaceSessionExecArtifactRef {
  readonly ref: string;
  readonly contentType?: string;
  readonly name?: string;
  readonly bytes?: number;
  readonly digest?: string;
}

export interface WorkspaceSessionExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly artifacts: ReadonlyArray<WorkspaceSessionExecArtifactRef>;
  readonly durationMs: number;
}

export type WorkspaceSessionExecFailureCode =
  | "SessionNotFound"
  | "PolicyDenied"
  | "Timeout"
  | "ExecFailed"
  | "ProviderFailure";

export interface WorkspaceSessionExecFailure {
  readonly code: WorkspaceSessionExecFailureCode;
  readonly reason: string;
  readonly sessionRef: string;
  readonly stdout?: string;
  readonly stderr?: string;
}

export interface WorkspaceSessionFailure {
  readonly code:
    | "ScopeNotSession"
    | "PolicyDenied"
    | "StartFailed"
    | "RestoreFailed"
    | "BackupFailed"
    | "PreviewFailed"
    | "DestroyFailed"
    | "ProviderFailure";
  readonly step: WorkspaceSessionLifecycleStep;
  readonly reason: string;
  readonly proofRef?: string;
  readonly claim: RejectedClaim;
}

export interface WorkspaceSessionCarrier {
  readonly start: (
    request: WorkspaceSessionStartRequest,
  ) => Effect.Effect<WorkspaceSessionStartedPayload, WorkspaceSessionFailure>;
  readonly restore: (
    request: WorkspaceSessionRestoreRequest,
  ) => Effect.Effect<WorkspaceSessionRestoredPayload, WorkspaceSessionFailure>;
  readonly backup: (
    request: WorkspaceSessionBackupRequest,
  ) => Effect.Effect<WorkspaceSessionBackedUpPayload, WorkspaceSessionFailure>;
  readonly allocatePreview: (
    request: WorkspaceSessionPreviewRequest,
  ) => Effect.Effect<WorkspaceSessionPreviewAllocatedPayload, WorkspaceSessionFailure>;
  readonly exec: (
    request: WorkspaceSessionExecRequest,
  ) => Effect.Effect<WorkspaceSessionExecResult, WorkspaceSessionExecFailure>;
  readonly destroy: (
    request: WorkspaceSessionDestroyRequest,
  ) => Effect.Effect<WorkspaceSessionDestroyedPayload, WorkspaceSessionFailure>;
}

export const workspaceSessionFailedPayload = (
  failure: WorkspaceSessionFailure,
  subjectRef: string,
): WorkspaceSessionFailedPayload => ({
  subjectRef,
  step: failure.step,
  reason: failure.reason,
  claim: failure.claim,
  ...(failure.proofRef === undefined ? {} : { proofRef: failure.proofRef }),
});
