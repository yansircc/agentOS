import { Predicate } from "effect";
import type { LivedClaim } from "@agent-os/kernel/effect-claim";
import { defineEventKindView, defineEventPayloads, payload } from "@agent-os/kernel/extensions";
import { validateTerminalClaim } from "@agent-os/kernel/settlement-contract";
import { gitSettlementContract } from "./settlement";

export interface GitWorkspaceCreatedPayload {
  readonly subjectRef: string;
  readonly workspaceRef: string;
  readonly baseRef: string;
  readonly branchRef: string;
  readonly claim: LivedClaim;
}

export interface GitCommitRecordedPayload {
  readonly subjectRef: string;
  readonly commitRef: string;
  readonly parentRef: string;
  readonly diffRef: string;
  readonly claim: LivedClaim;
}

export interface GitMergeRecordedPayload {
  readonly subjectRef: string;
  readonly mergeCommitRef: string;
  readonly targetRef: string;
  readonly claim: LivedClaim;
}

export interface GitRevertRecordedPayload {
  readonly subjectRef: string;
  readonly revertCommitRef: string;
  readonly revertedRef: string;
  readonly claim: LivedClaim;
}

export interface GitWorkspaceCleanedPayload {
  readonly subjectRef: string;
  readonly workspaceRef: string;
  readonly claim: LivedClaim;
}

export const GIT_EVENTS = defineEventPayloads({
  "git.workspace.created": payload<GitWorkspaceCreatedPayload>(),
  "git.commit.recorded": payload<GitCommitRecordedPayload>(),
  "git.merge.recorded": payload<GitMergeRecordedPayload>(),
  "git.revert.recorded": payload<GitRevertRecordedPayload>(),
  "git.workspace.cleaned": payload<GitWorkspaceCleanedPayload>(),
});

export const GIT_KIND = defineEventKindView(GIT_EVENTS, {
  WORKSPACE_CREATED: "git.workspace.created",
  COMMIT_RECORDED: "git.commit.recorded",
  MERGE_RECORDED: "git.merge.recorded",
  REVERT_RECORDED: "git.revert.recorded",
  WORKSPACE_CLEANED: "git.workspace.cleaned",
});

export type GitEventKind = keyof typeof GIT_EVENTS;

export interface GitLedgerEvent {
  readonly id: number;
  readonly kind: string;
  readonly payload: unknown;
}

export interface GitSubjectProjection {
  readonly subjectRef: string;
  readonly workspaceRef?: string;
  readonly baseRef?: string;
  readonly branchRef?: string;
  readonly commitRefs: ReadonlyArray<string>;
  readonly mergeCommitRef?: string;
  readonly revertCommitRef?: string;
  readonly cleaned: boolean;
}

const stringField = (payload: Record<string, unknown>, key: string): string | undefined =>
  typeof payload[key] === "string" ? payload[key] : undefined;

const livedClaimFrom = (value: unknown): LivedClaim | undefined => {
  const result = validateTerminalClaim(gitSettlementContract, value);
  return result.ok && result.claim.phase === "lived" ? result.claim : undefined;
};

export const projectGitSubject = (
  events: Iterable<GitLedgerEvent>,
  subjectRef: string,
): GitSubjectProjection => {
  let workspaceRef: string | undefined;
  let baseRef: string | undefined;
  let branchRef: string | undefined;
  let mergeCommitRef: string | undefined;
  let revertCommitRef: string | undefined;
  let cleaned = false;
  const commitRefs: string[] = [];

  for (const event of events) {
    if (!Predicate.isRecord(event.payload)) continue;
    if (event.payload.subjectRef !== subjectRef) continue;
    if (livedClaimFrom(event.payload.claim) === undefined) continue;
    switch (event.kind) {
      case GIT_KIND.WORKSPACE_CREATED:
        workspaceRef = stringField(event.payload, "workspaceRef");
        baseRef = stringField(event.payload, "baseRef");
        branchRef = stringField(event.payload, "branchRef");
        cleaned = false;
        break;
      case GIT_KIND.COMMIT_RECORDED: {
        const commitRef = stringField(event.payload, "commitRef");
        if (commitRef !== undefined) commitRefs.push(commitRef);
        break;
      }
      case GIT_KIND.MERGE_RECORDED:
        mergeCommitRef = stringField(event.payload, "mergeCommitRef");
        break;
      case GIT_KIND.REVERT_RECORDED:
        revertCommitRef = stringField(event.payload, "revertCommitRef");
        break;
      case GIT_KIND.WORKSPACE_CLEANED:
        cleaned = true;
        break;
    }
  }

  return {
    subjectRef,
    workspaceRef,
    baseRef,
    branchRef,
    commitRefs,
    mergeCommitRef,
    revertCommitRef,
    cleaned,
  };
};
