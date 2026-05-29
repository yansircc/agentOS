import { Schema } from "effect";
import { defineCarrier, event, ledgerProjection, lived } from "@agent-os/kernel/carrier";

export const VERIFICATION_EVENT_PREFIX = "verification.";

export const verificationCarrier = defineCarrier({
  packageId: "@agent-os/verification",
  prefix: VERIFICATION_EVENT_PREFIX,
  roles: ["generator", "reader"],
  events: {
    gate_recorded: event({
      kind: "gate.recorded",
      payload: Schema.Struct({
        subjectRef: Schema.String,
        gate: Schema.String,
        status: Schema.Literal("passed", "failed"),
        proofRef: Schema.String,
        fingerprint: Schema.String,
        summary: Schema.optional(Schema.String),
      }),
      claim: lived({ key: "claim", anchorKinds: ["carrier_proof", "external_receipt"] }),
    }),
  },
  projection: ledgerProjection({
    initial: () => ({ ready: false }),
    reduce: (state) => state,
  }),
});

export const VERIFICATION_KIND = verificationCarrier.kind;
export const VERIFICATION_EVENTS = verificationCarrier.events;
export const verificationBoundaryContract = verificationCarrier.boundaryContract;
export const verificationSettlementContract = verificationCarrier.settlementContract;
export const verificationBoundaryPackage = verificationCarrier.boundaryPackage;
