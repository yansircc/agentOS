import {
  GIT_EVENTS,
  gitCarrierExtensionPackage,
  projectGitSubject,
} from "../src";

describe("@agent-os/git-carrier", () => {
  it("declares git.* as an extension-owned prefix", () => {
    expect(gitCarrierExtensionPackage("0.1.0")).toEqual({
      packageId: "@agent-os/git-carrier",
      kindPrefixes: ["git."],
      version: "0.1.0",
    });
  });

  it("projects workspace, commits, merge, and cleanup by subject ref", () => {
    const events = [
      {
        id: 1,
        kind: GIT_EVENTS.WORKSPACE_CREATED,
        payload: {
          subjectRef: "ch-1",
          workspaceRef: "worktree://ch-1",
          baseRef: "main@abc",
          branchRef: "change/ch-1",
        },
      },
      {
        id: 2,
        kind: GIT_EVENTS.COMMIT_RECORDED,
        payload: {
          subjectRef: "ch-1",
          commitRef: "commit://def",
          parentRef: "main@abc",
          diffRef: "diff://def",
        },
      },
      {
        id: 3,
        kind: GIT_EVENTS.MERGE_RECORDED,
        payload: {
          subjectRef: "ch-1",
          mergeCommitRef: "commit://merge",
          targetRef: "main",
        },
      },
      {
        id: 4,
        kind: GIT_EVENTS.WORKSPACE_CLEANED,
        payload: {
          subjectRef: "ch-1",
          workspaceRef: "worktree://ch-1",
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
});
