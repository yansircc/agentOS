import { GIT_EVENT_PREFIX } from "./extension";

export const GIT_EVENTS = {
  WORKSPACE_CREATED: `${GIT_EVENT_PREFIX}workspace.created`,
  COMMIT_RECORDED: `${GIT_EVENT_PREFIX}commit.recorded`,
  MERGE_RECORDED: `${GIT_EVENT_PREFIX}merge.recorded`,
  REVERT_RECORDED: `${GIT_EVENT_PREFIX}revert.recorded`,
  WORKSPACE_CLEANED: `${GIT_EVENT_PREFIX}workspace.cleaned`,
} as const;

export type GitEventKind = (typeof GIT_EVENTS)[keyof typeof GIT_EVENTS];

export interface GitWorkspaceCreatedPayload {
  readonly changeId: string;
  readonly workspaceRef: string;
  readonly baseRef: string;
  readonly branchRef: string;
}

export interface GitCommitRecordedPayload {
  readonly changeId: string;
  readonly commitRef: string;
  readonly parentRef: string;
  readonly diffRef: string;
}

export interface GitMergeRecordedPayload {
  readonly changeId: string;
  readonly mergeCommitRef: string;
  readonly targetRef: string;
}

export interface GitRevertRecordedPayload {
  readonly changeId: string;
  readonly revertCommitRef: string;
  readonly revertedRef: string;
}

export interface GitWorkspaceCleanedPayload {
  readonly changeId: string;
  readonly workspaceRef: string;
}

export interface GitLedgerEvent {
  readonly id: number;
  readonly kind: string;
  readonly payload: unknown;
}

export interface GitChangeProjection {
  readonly changeId: string;
  readonly workspaceRef?: string;
  readonly baseRef?: string;
  readonly branchRef?: string;
  readonly commitRefs: ReadonlyArray<string>;
  readonly mergeCommitRef?: string;
  readonly revertCommitRef?: string;
  readonly cleaned: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringField = (
  payload: Record<string, unknown>,
  key: string,
): string | undefined =>
  typeof payload[key] === "string" ? payload[key] : undefined;

export const projectGitChange = (
  events: Iterable<GitLedgerEvent>,
  changeId: string,
): GitChangeProjection => {
  let workspaceRef: string | undefined;
  let baseRef: string | undefined;
  let branchRef: string | undefined;
  let mergeCommitRef: string | undefined;
  let revertCommitRef: string | undefined;
  let cleaned = false;
  const commitRefs: string[] = [];

  for (const event of events) {
    if (!isRecord(event.payload)) continue;
    if (event.payload.changeId !== changeId) continue;
    switch (event.kind) {
      case GIT_EVENTS.WORKSPACE_CREATED:
        workspaceRef = stringField(event.payload, "workspaceRef");
        baseRef = stringField(event.payload, "baseRef");
        branchRef = stringField(event.payload, "branchRef");
        cleaned = false;
        break;
      case GIT_EVENTS.COMMIT_RECORDED: {
        const commitRef = stringField(event.payload, "commitRef");
        if (commitRef !== undefined) commitRefs.push(commitRef);
        break;
      }
      case GIT_EVENTS.MERGE_RECORDED:
        mergeCommitRef = stringField(event.payload, "mergeCommitRef");
        break;
      case GIT_EVENTS.REVERT_RECORDED:
        revertCommitRef = stringField(event.payload, "revertCommitRef");
        break;
      case GIT_EVENTS.WORKSPACE_CLEANED:
        cleaned = true;
        break;
    }
  }

  return {
    changeId,
    workspaceRef,
    baseRef,
    branchRef,
    commitRefs,
    mergeCommitRef,
    revertCommitRef,
    cleaned,
  };
};
