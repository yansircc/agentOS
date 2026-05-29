import { Schema } from "effect";
import { defineCarrier, event, ledgerProjection, lived, rejected } from "@agent-os/kernel/carrier";

export const DEPLOY_EVENT_PREFIX = "deploy.";

export const deployCarrier = defineCarrier({
  packageId: "@agent-os/deploy",
  prefix: DEPLOY_EVENT_PREFIX,
  roles: ["generator", "resolver", "reader"],
  events: {
    preview_recorded: event({
      kind: "preview.recorded",
      payload: Schema.Struct({
        subjectRef: Schema.String,
        previewRef: Schema.String,
        artifactRef: Schema.String,
      }),
      claim: lived({ key: "claim", anchorKinds: ["carrier_proof", "external_receipt"] }),
    }),
    production_promoted: event({
      kind: "production.promoted",
      payload: Schema.Struct({
        subjectRef: Schema.String,
        deployRef: Schema.String,
        productionRef: Schema.String,
        rollbackRef: Schema.optional(Schema.String),
      }),
      claim: lived({ key: "claim", anchorKinds: ["carrier_proof", "external_receipt"] }),
    }),
    production_readback: event({
      kind: "production.readback",
      payload: Schema.Struct({
        subjectRef: Schema.String,
        productionRef: Schema.String,
        readbackRef: Schema.String,
        status: Schema.Literal("passed", "failed"),
      }),
      claim: lived({ key: "claim", anchorKinds: ["carrier_proof", "external_receipt"] }),
    }),
    rollback_recorded: event({
      kind: "rollback.recorded",
      payload: Schema.Struct({
        subjectRef: Schema.String,
        rollbackRef: Schema.String,
        restoredDeployRef: Schema.String,
      }),
      claim: lived({ key: "claim", anchorKinds: ["carrier_proof", "external_receipt"] }),
    }),
    failed: event({
      kind: "failed",
      payload: Schema.Struct({
        subjectRef: Schema.String,
        step: Schema.Literal("preview", "promote", "readback", "rollback"),
        proofRef: Schema.String,
        reason: Schema.String,
      }),
      claim: rejected({
        key: "claim",
        rejectionKinds: ["provider_rejected", "policy_denied", "validation_failed"],
      }),
    }),
  },
  projection: ledgerProjection({
    initial: () => ({ status: "missing" as const }),
    reduce: (state) => state,
  }),
});

export const DEPLOY_KIND = deployCarrier.kind;
export const DEPLOY_EVENTS = deployCarrier.events;
export const deployBoundaryContract = deployCarrier.boundaryContract;
export const deploySettlementContract = deployCarrier.settlementContract;
export const deployBoundaryPackage = deployCarrier.boundaryPackage;
