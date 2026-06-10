import { Schema } from "effect";
import { defineCarrier, event, lived, none, pre } from "@agent-os/kernel/carrier";

export const DECISION_GATE_EVENT_PREFIX = "decision_gate.";

const rejectionRefSchema = Schema.Struct({
  rejectionId: Schema.String,
  rejectionKind: Schema.Literal(
    "capability_denied",
    "policy_denied",
    "validation_failed",
    "unsupported",
    "resource_denied",
    "provider_rejected",
  ),
  reason: Schema.optional(Schema.String),
});

export const decisionGateCarrier = defineCarrier({
  packageId: "@agent-os/decision-gate",
  prefix: DECISION_GATE_EVENT_PREFIX,
  roles: ["admitter", "reader"],
  events: {
    requested: event({
      kind: "requested",
      payload: Schema.Struct({
        gateRef: Schema.String,
        subjectRef: Schema.String,
        policyRef: Schema.optional(Schema.String),
        summary: Schema.optional(Schema.String),
      }),
      claim: pre({ key: "claim" }),
    }),
    decided: event({
      kind: "decided",
      payload: Schema.Struct({
        gateRef: Schema.String,
        decisionRef: Schema.String,
        decision: Schema.Literal("approved", "rejected"),
        decidedBy: Schema.String,
        reason: Schema.optional(Schema.String),
        rejectionRef: Schema.optional(rejectionRefSchema),
      }),
      claim: none(),
    }),
    consumed: event({
      kind: "consumed",
      payload: Schema.Struct({
        gateRef: Schema.String,
        decisionRef: Schema.String,
        consumedBy: Schema.String,
      }),
      claim: lived({ key: "claim", anchorKinds: ["ledger_event"] }),
    }),
  },
});

export const DECISION_GATE_KIND = decisionGateCarrier.kind;
export const DECISION_GATE_EVENTS = decisionGateCarrier.events;
export const decisionGateBoundaryContract = decisionGateCarrier.boundaryContract;
export const decisionGateSettlementContract = decisionGateCarrier.settlementContract;
export const decisionGateBoundaryPackage = decisionGateCarrier.boundaryPackage;
