import { Schema } from "effect";
import { defineCarrier, event, lived, rejected } from "@agent-os/core/carrier";

export const WORKSPACE_SESSION_EVENT_PREFIX = "workspace_session.";

const retentionSchema = Schema.Struct({
  mode: Schema.Literals(["ephemeral", "persistent"]),
  leaseRef: Schema.optional(Schema.String),
  expiresAt: Schema.optional(Schema.String),
});

export const workspaceSessionCarrier = defineCarrier({
  ownerId: "@agent-os/workspace-session",
  sourcePackageName: "@agent-os/workspace-session",
  prefix: WORKSPACE_SESSION_EVENT_PREFIX,
  roles: ["resolver", "reader"],
  events: {
    started: event({
      kind: "started",
      payload: Schema.Struct({
        subjectRef: Schema.String,
        sessionRef: Schema.String,
        workspaceRootRef: Schema.String,
        cleanupRef: Schema.String,
        retention: Schema.optional(retentionSchema),
      }),
      claim: lived({ key: "claim", anchorKinds: ["carrier_proof"] }),
    }),
    restored: event({
      kind: "restored",
      payload: Schema.Struct({
        subjectRef: Schema.String,
        sessionRef: Schema.String,
        backupRef: Schema.String,
        workspaceRootRef: Schema.String,
        cleanupRef: Schema.String,
        retention: Schema.optional(retentionSchema),
      }),
      claim: lived({ key: "claim", anchorKinds: ["carrier_proof"] }),
    }),
    backed_up: event({
      kind: "backed_up",
      payload: Schema.Struct({
        subjectRef: Schema.String,
        sessionRef: Schema.String,
        backupRef: Schema.String,
        expiresAt: Schema.optional(Schema.String),
      }),
      claim: lived({ key: "claim", anchorKinds: ["carrier_proof"] }),
    }),
    preview_allocated: event({
      kind: "preview_allocated",
      payload: Schema.Struct({
        subjectRef: Schema.String,
        sessionRef: Schema.String,
        previewRef: Schema.String,
        port: Schema.Number,
      }),
      claim: lived({ key: "claim", anchorKinds: ["carrier_proof"] }),
    }),
    destroyed: event({
      kind: "destroyed",
      payload: Schema.Struct({
        subjectRef: Schema.String,
        sessionRef: Schema.String,
        reason: Schema.Literals(["completed", "expired", "aborted", "manual"]),
      }),
      claim: lived({ key: "claim", anchorKinds: ["carrier_proof"] }),
    }),
    failed: event({
      kind: "failed",
      payload: Schema.Struct({
        subjectRef: Schema.String,
        step: Schema.Literals(["start", "restore", "backup", "preview", "destroy"]),
        proofRef: Schema.optional(Schema.String),
        reason: Schema.String,
      }),
      claim: rejected({
        key: "claim",
        rejectionKinds: ["unsupported", "policy_denied", "provider_rejected", "resource_denied"],
      }),
    }),
  },
});

export const WORKSPACE_SESSION_KIND = workspaceSessionCarrier.kind;
export const WORKSPACE_SESSION_EVENTS = workspaceSessionCarrier.events;
export const workspaceSessionBoundaryContract = workspaceSessionCarrier.boundaryContract;
export const workspaceSessionSettlementContract = workspaceSessionCarrier.settlementContract;
export const workspaceSessionBoundaryPackage = workspaceSessionCarrier.boundaryPackage;
