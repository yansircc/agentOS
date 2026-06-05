import { Schema } from "effect";
import { defineCarrier, event, ledgerProjection, lived, rejected } from "@agent-os/kernel/carrier";

export const WORKSPACE_SESSION_EVENT_PREFIX = "workspace_session.";

const retentionSchema = Schema.Struct({
  mode: Schema.Literal("ephemeral", "persistent"),
  leaseRef: Schema.optional(Schema.String),
  expiresAt: Schema.optional(Schema.String),
});

export const workspaceSessionCarrier = defineCarrier({
  packageId: "@agent-os/workspace-session",
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
        reason: Schema.Literal("completed", "expired", "aborted", "manual"),
      }),
      claim: lived({ key: "claim", anchorKinds: ["carrier_proof"] }),
    }),
    failed: event({
      kind: "failed",
      payload: Schema.Struct({
        subjectRef: Schema.String,
        step: Schema.Literal("start", "restore", "backup", "preview", "destroy"),
        proofRef: Schema.optional(Schema.String),
        reason: Schema.String,
      }),
      claim: rejected({
        key: "claim",
        rejectionKinds: ["unsupported", "policy_denied", "provider_rejected", "resource_denied"],
      }),
    }),
  },
  projection: ledgerProjection({
    initial: () => ({ status: "missing" as const }),
    reduce: (state) => state,
  }),
});

export const WORKSPACE_SESSION_KIND = workspaceSessionCarrier.kind;
export const WORKSPACE_SESSION_EVENTS = workspaceSessionCarrier.events;
export const workspaceSessionBoundaryContract = workspaceSessionCarrier.boundaryContract;
export const workspaceSessionSettlementContract = workspaceSessionCarrier.settlementContract;
export const workspaceSessionBoundaryPackage = workspaceSessionCarrier.boundaryPackage;
