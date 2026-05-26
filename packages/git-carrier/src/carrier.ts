import type { Effect } from "effect";
import type {
  PreClaim,
  RejectedClaim,
} from "@agent-os/core/effect-claim";

import type {
  GitCommitRecordedPayload,
  GitMergeRecordedPayload,
  GitRevertRecordedPayload,
  GitWorkspaceCleanedPayload,
  GitWorkspaceCreatedPayload,
} from "./events";

export interface GitWorkspaceRequest {
  readonly claim?: PreClaim;
  readonly subjectRef: string;
  readonly sourceRef: string;
  readonly baseRef: string;
}

export interface GitCommitRequest {
  readonly claim?: PreClaim;
  readonly subjectRef: string;
  readonly workspaceRef: string;
  readonly message: string;
}

export interface GitMergeRequest {
  readonly claim?: PreClaim;
  readonly subjectRef: string;
  readonly workspaceRef: string;
  readonly targetRef: string;
}

export interface GitRevertRequest {
  readonly claim?: PreClaim;
  readonly subjectRef: string;
  readonly targetRef: string;
  readonly revertedRef: string;
}

export interface GitCleanupRequest {
  readonly claim?: PreClaim;
  readonly subjectRef: string;
  readonly workspaceRef: string;
}

export interface GitCarrierFailure {
  readonly code:
    | "WorkspaceUnavailable"
    | "CommitRejected"
    | "MergeRejected"
    | "RevertRejected"
    | "CleanupFailed"
    | "ProviderFailure";
  readonly reason: string;
  readonly proofRef?: string;
  readonly claim?: RejectedClaim;
}

export interface GitCarrier {
  readonly createWorkspace: (
    request: GitWorkspaceRequest,
  ) => Effect.Effect<GitWorkspaceCreatedPayload, GitCarrierFailure>;
  readonly recordCommit: (
    request: GitCommitRequest,
  ) => Effect.Effect<GitCommitRecordedPayload, GitCarrierFailure>;
  readonly merge: (
    request: GitMergeRequest,
  ) => Effect.Effect<GitMergeRecordedPayload, GitCarrierFailure>;
  readonly revert: (
    request: GitRevertRequest,
  ) => Effect.Effect<GitRevertRecordedPayload, GitCarrierFailure>;
  readonly cleanupWorkspace: (
    request: GitCleanupRequest,
  ) => Effect.Effect<GitWorkspaceCleanedPayload, GitCarrierFailure>;
}
