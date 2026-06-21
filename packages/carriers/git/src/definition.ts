import { Schema } from "effect";
import { defineCarrier, event, lived } from "@agent-os/core/carrier";

export const GIT_EVENT_PREFIX = "git.";

export const gitCarrier = defineCarrier({
  ownerId: "@agent-os/git-carrier",
  sourcePackageName: "@agent-os/git-carrier",
  prefix: GIT_EVENT_PREFIX,
  roles: ["generator", "resolver", "reader"],
  events: {
    workspace_created: event({
      kind: "workspace.created",
      payload: Schema.Struct({
        subjectRef: Schema.String,
        workspaceRef: Schema.String,
        baseRef: Schema.String,
        branchRef: Schema.String,
      }),
      claim: lived({ key: "claim", anchorKinds: ["carrier_proof"] }),
    }),
    commit_recorded: event({
      kind: "commit.recorded",
      payload: Schema.Struct({
        subjectRef: Schema.String,
        commitRef: Schema.String,
        parentRef: Schema.String,
        diffRef: Schema.String,
      }),
      claim: lived({ key: "claim", anchorKinds: ["carrier_proof"] }),
    }),
    merge_recorded: event({
      kind: "merge.recorded",
      payload: Schema.Struct({
        subjectRef: Schema.String,
        mergeCommitRef: Schema.String,
        targetRef: Schema.String,
      }),
      claim: lived({ key: "claim", anchorKinds: ["carrier_proof"] }),
    }),
    revert_recorded: event({
      kind: "revert.recorded",
      payload: Schema.Struct({
        subjectRef: Schema.String,
        revertCommitRef: Schema.String,
        revertedRef: Schema.String,
      }),
      claim: lived({ key: "claim", anchorKinds: ["carrier_proof"] }),
    }),
    workspace_cleaned: event({
      kind: "workspace.cleaned",
      payload: Schema.Struct({
        subjectRef: Schema.String,
        workspaceRef: Schema.String,
      }),
      claim: lived({ key: "claim", anchorKinds: ["carrier_proof"] }),
    }),
  },
});

export const GIT_KIND = gitCarrier.kind;
export const GIT_EVENTS = gitCarrier.events;
export const gitCarrierBoundaryContract = gitCarrier.boundaryContract;
export const gitSettlementContract = gitCarrier.settlementContract;
export const gitCarrierBoundaryPackage = gitCarrier.boundaryPackage;
