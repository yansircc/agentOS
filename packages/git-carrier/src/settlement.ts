import type { ExtensionCapability } from "@agent-os/core/extensions";

import {
  GIT_EVENTS,
  type GitCommitRecordedPayload,
  type GitMergeRecordedPayload,
  type GitRevertRecordedPayload,
  type GitWorkspaceCleanedPayload,
  type GitWorkspaceCreatedPayload,
} from "./events";

export const commitGitWorkspaceCreated = (
  cap: ExtensionCapability,
  payload: GitWorkspaceCreatedPayload,
): Promise<{ readonly id: number }> =>
  cap.commit({ event: GIT_EVENTS.WORKSPACE_CREATED, data: payload });

export const commitGitCommitRecorded = (
  cap: ExtensionCapability,
  payload: GitCommitRecordedPayload,
): Promise<{ readonly id: number }> =>
  cap.commit({ event: GIT_EVENTS.COMMIT_RECORDED, data: payload });

export const commitGitMergeRecorded = (
  cap: ExtensionCapability,
  payload: GitMergeRecordedPayload,
): Promise<{ readonly id: number }> =>
  cap.commit({ event: GIT_EVENTS.MERGE_RECORDED, data: payload });

export const commitGitRevertRecorded = (
  cap: ExtensionCapability,
  payload: GitRevertRecordedPayload,
): Promise<{ readonly id: number }> =>
  cap.commit({ event: GIT_EVENTS.REVERT_RECORDED, data: payload });

export const commitGitWorkspaceCleaned = (
  cap: ExtensionCapability,
  payload: GitWorkspaceCleanedPayload,
): Promise<{ readonly id: number }> =>
  cap.commit({ event: GIT_EVENTS.WORKSPACE_CLEANED, data: payload });
