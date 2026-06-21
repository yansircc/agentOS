import { Schema } from "effect";
import { defineCarrier, event, lived } from "@agent-os/core/carrier";

export const VERIFICATION_EVENT_PREFIX = "verification.";

export const verificationCarrier = defineCarrier({
  ownerId: "@agent-os/verification",
  sourcePackageName: "@agent-os/verification",
  prefix: VERIFICATION_EVENT_PREFIX,
  roles: ["generator", "reader"],
  events: {
    gate_recorded: event({
      kind: "gate.recorded",
      payload: Schema.Struct({
        subjectRef: Schema.String,
        gate: Schema.String,
        status: Schema.Literals(["passed", "failed"]),
        proofRef: Schema.String,
        fingerprint: Schema.String,
        summary: Schema.optional(Schema.String),
      }),
      claim: lived({ key: "claim", anchorKinds: ["carrier_proof", "external_receipt"] }),
    }),
  },
});

export const VERIFICATION_KIND = verificationCarrier.kind;
export const VERIFICATION_EVENTS = verificationCarrier.events;
export const verificationBoundaryContract = verificationCarrier.boundaryContract;
export const verificationSettlementContract = verificationCarrier.settlementContract;
export const verificationBoundaryPackage = verificationCarrier.boundaryPackage;
