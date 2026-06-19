import { Schema } from "effect";
import { defineCarrier, event, indeterminate, lived, rejected } from "@agent-os/kernel/carrier";
import { SYMBOLIC_SETTLEMENT_VALUE_PATTERN } from "@agent-os/kernel/settlement-contract";

export const DEPLOY_EVENT_PREFIX = "deploy.";
const DeploySymbolicRef = Schema.String.pipe(
  Schema.check(Schema.isPattern(new RegExp(SYMBOLIC_SETTLEMENT_VALUE_PATTERN))),
);

export const deployCarrier = defineCarrier({
  packageId: "@agent-os/deploy",
  prefix: DEPLOY_EVENT_PREFIX,
  roles: ["generator", "resolver", "reader"],
  events: {
    preview_recorded: event({
      kind: "preview.recorded",
      payload: Schema.Struct({
        subjectRef: Schema.String,
        previewRef: DeploySymbolicRef,
        artifactRef: DeploySymbolicRef,
      }),
      claim: lived({ key: "claim", anchorKinds: ["carrier_proof", "external_receipt"] }),
    }),
    production_promoted: event({
      kind: "production.promoted",
      payload: Schema.Struct({
        subjectRef: Schema.String,
        deployRef: DeploySymbolicRef,
        productionRef: DeploySymbolicRef,
        rollbackRef: Schema.optional(DeploySymbolicRef),
      }),
      claim: lived({ key: "claim", anchorKinds: ["carrier_proof", "external_receipt"] }),
    }),
    production_readback: event({
      kind: "production.readback",
      payload: Schema.Struct({
        subjectRef: Schema.String,
        productionRef: DeploySymbolicRef,
        readbackRef: DeploySymbolicRef,
        status: Schema.Literals(["passed", "failed"]),
      }),
      claim: lived({ key: "claim", anchorKinds: ["carrier_proof", "external_receipt"] }),
    }),
    rollback_recorded: event({
      kind: "rollback.recorded",
      payload: Schema.Struct({
        subjectRef: Schema.String,
        rollbackRef: DeploySymbolicRef,
        restoredDeployRef: DeploySymbolicRef,
      }),
      claim: lived({ key: "claim", anchorKinds: ["carrier_proof", "external_receipt"] }),
    }),
    failed: event({
      kind: "failed",
      payload: Schema.Struct({
        subjectRef: Schema.String,
        step: Schema.Literals(["preview", "promote", "readback", "rollback"]),
        proofRef: DeploySymbolicRef,
        reason: Schema.String,
      }),
      claim: rejected({
        key: "claim",
        rejectionKinds: ["provider_rejected", "policy_denied", "validation_failed"],
      }),
    }),
    reconcile_required: event({
      kind: "reconcile_required",
      payload: Schema.Struct({
        subjectRef: Schema.String,
        step: Schema.Literals(["preview", "promote", "readback", "rollback"]),
        proofRef: DeploySymbolicRef,
        reason: DeploySymbolicRef,
      }),
      claim: indeterminate({
        key: "claim",
        indeterminateKinds: ["reconcile_required", "witness_unavailable"],
      }),
    }),
  },
});

export const DEPLOY_KIND = deployCarrier.kind;
export const DEPLOY_EVENTS = deployCarrier.events;
export const deployBoundaryContract = deployCarrier.boundaryContract;
export const deploySettlementContract = deployCarrier.settlementContract;
export const deployBoundaryPackage = deployCarrier.boundaryPackage;
