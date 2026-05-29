import {
  GIT_EVENTS,
  GIT_KIND,
  gitCarrierBoundaryPackage,
  gitSettlementRef,
  projectGitSubject,
  settleGitLived,
} from "../src";
import { makePreClaim } from "@agent-os/kernel/effect-claim";
import { makeCommitters, type ExtensionCapability } from "@agent-os/kernel/extensions";

const gitClaim = makePreClaim({
  operationRef: "git:session-1:commit",
  scopeRef: { kind: "session", scopeId: "session/1" },
  authorityRef: {
    authorityId: "@agent-os/git-carrier.commit",
    authorityClass: "write",
  },
  originRef: {
    originId: "@agent-os/git-carrier",
    originKind: "extension_package",
  },
});
const livedGitClaim = (anchorId: string) =>
  settleGitLived(gitClaim, {
    proofRef: gitSettlementRef(anchorId),
    carrierRef: "git",
  });

describe("@agent-os/git-carrier", () => {
  it("declares git.* as an extension-owned prefix", () => {
    expect(gitCarrierBoundaryPackage("0.1.0")).toMatchObject({
      packageId: "@agent-os/git-carrier",
      kindPrefixes: ["git."],
      version: "0.1.0",
    });
  });

  it("projects workspace, commits, merge, and cleanup by subject ref", () => {
    const events = [
      {
        id: 1,
        kind: GIT_KIND.WORKSPACE_CREATED,
        payload: {
          subjectRef: "ch-1",
          workspaceRef: "worktree://ch-1",
          baseRef: "main@abc",
          branchRef: "change/ch-1",
          claim: livedGitClaim("worktree://ch-1"),
        },
      },
      {
        id: 2,
        kind: GIT_KIND.COMMIT_RECORDED,
        payload: {
          subjectRef: "ch-1",
          commitRef: "commit://def",
          parentRef: "main@abc",
          diffRef: "diff://def",
          claim: livedGitClaim("commit://def"),
        },
      },
      {
        id: 3,
        kind: GIT_KIND.MERGE_RECORDED,
        payload: {
          subjectRef: "ch-1",
          mergeCommitRef: "commit://merge",
          targetRef: "main",
          claim: livedGitClaim("commit://merge"),
        },
      },
      {
        id: 4,
        kind: GIT_KIND.WORKSPACE_CLEANED,
        payload: {
          subjectRef: "ch-1",
          workspaceRef: "worktree://ch-1",
          claim: livedGitClaim("worktree://ch-1:cleaned"),
        },
      },
    ] as const;

    expect(projectGitSubject(events, "ch-1")).toMatchObject({
      subjectRef: "ch-1",
      workspaceRef: "worktree://ch-1",
      baseRef: "main@abc",
      branchRef: "change/ch-1",
      commitRefs: ["commit://def"],
      mergeCommitRef: "commit://merge",
      cleaned: true,
    });
  });

  it("settles git.* facts through ExtensionCapability", async () => {
    const committed: Array<{ event: string; data: unknown }> = [];
    const cap: ExtensionCapability = {
      packageId: "@agent-os/git-carrier",
      kindPrefixes: ["git."],
      version: "0.1.0",
      commit: async (spec) => {
        committed.push(spec);
        return { id: committed.length };
      },
      time: async (spec) => {
        committed.push(spec);
        return { id: committed.length };
      },
    };

    await expect(
      makeCommitters(GIT_EVENTS, cap)[GIT_KIND.COMMIT_RECORDED]({
        subjectRef: "session:1",
        commitRef: "commit://def",
        parentRef: "main@abc",
        diffRef: "diff://def",
        claim: livedGitClaim("commit://def"),
      }),
    ).resolves.toEqual({ id: 1 });

    expect(committed).toEqual([
      {
        event: GIT_KIND.COMMIT_RECORDED,
        data: {
          subjectRef: "session:1",
          commitRef: "commit://def",
          parentRef: "main@abc",
          diffRef: "diff://def",
          claim: {
            phase: "lived",
            operationRef: "git:session-1:commit",
            scopeRef: { kind: "session", scopeId: "session/1" },
            authorityRef: {
              authorityId: "@agent-os/git-carrier.commit",
              authorityClass: "write",
            },
            originRef: {
              originId: "@agent-os/git-carrier",
              originKind: "extension_package",
            },
            anchorRef: {
              anchorId: gitSettlementRef("commit://def"),
              anchorKind: "carrier_proof",
              carrierRef: "git",
            },
          },
        },
      },
    ]);
  });
});
