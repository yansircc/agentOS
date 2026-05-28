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
