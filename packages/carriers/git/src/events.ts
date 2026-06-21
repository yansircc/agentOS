import { Predicate } from "effect";
import type { LivedClaim } from "@agent-os/core/effect-claim";
import { validateTerminalClaim } from "@agent-os/core/settlement-contract";
import { GIT_EVENTS, GIT_KIND, gitSettlementContract } from "./definition";
export { GIT_EVENTS, GIT_KIND } from "./definition";

type GitPayloads = typeof GIT_EVENTS;

export type GitWorkspaceCreatedPayload = GitPayloads[(typeof GIT_KIND)["WORKSPACE_CREATED"]];
export type GitCommitRecordedPayload = GitPayloads[(typeof GIT_KIND)["COMMIT_RECORDED"]];
export type GitMergeRecordedPayload = GitPayloads[(typeof GIT_KIND)["MERGE_RECORDED"]];
export type GitRevertRecordedPayload = GitPayloads[(typeof GIT_KIND)["REVERT_RECORDED"]];
export type GitWorkspaceCleanedPayload = GitPayloads[(typeof GIT_KIND)["WORKSPACE_CLEANED"]];

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
    if (!Predicate.isObject(event.payload)) continue;
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
