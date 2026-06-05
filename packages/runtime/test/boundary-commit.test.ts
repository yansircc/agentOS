import { describe, expect, it } from "@effect/vitest";

import {
  defineBoundaryContract,
  type BoundaryEventContract,
} from "@agent-os/kernel/boundary-contract";
import { makePreClaim } from "@agent-os/kernel/effect-claim";
import {
  defineSettlementContract,
  settleLived,
  settleRejected,
} from "@agent-os/kernel/settlement-contract";
import { validateBoundaryEventPayload } from "../src/boundary-commit";

const emptyPayload = {
  type: "object",
  properties: {},
  additionalProperties: false,
} satisfies BoundaryEventContract["payloadSchema"];

const settlement = defineSettlementContract({
  settlementId: "@agent-os/slot-vocab",
  anchorKinds: ["ledger_event", "carrier_proof"],
  rejectionKinds: ["policy_denied", "provider_rejected"],
});

const contract = defineBoundaryContract({
  packageId: "@agent-os/slot-vocab",
  kindPrefixes: ["slot."],
  roles: ["generator", "reader"],
  events: {
    "slot.ledgered": {
      payloadSchema: emptyPayload,
      claim: { key: "claim", phase: "lived", anchorKinds: ["ledger_event"] },
    },
    "slot.proved": {
      payloadSchema: emptyPayload,
      claim: { key: "claim", phase: "lived", anchorKinds: ["carrier_proof"] },
    },
    "slot.denied": {
      payloadSchema: emptyPayload,
      claim: { key: "claim", phase: "rejected", rejectionKinds: ["policy_denied"] },
    },
    "slot.failed": {
      payloadSchema: emptyPayload,
      claim: { key: "claim", phase: "rejected", rejectionKinds: ["provider_rejected"] },
    },
  },
  authorityContracts: [],
  materialRequirements: [],
  settlement,
  projection: {
    derivedFromLedger: true,
    shadowState: false,
  },
});

const claim = makePreClaim({
  operationRef: "slot:op",
  scopeRef: { kind: "conversation", scopeId: "thread:1" },
  authorityRef: { authorityId: "slot.record", authorityClass: "effect" },
  originRef: { originId: "slot-test", originKind: "test" },
});

describe("boundary commit validation", () => {
  it("rejects terminal claims outside the event-local slot vocabulary", () => {
    const carrierProofClaim = settleLived(settlement, claim, {
      anchorKind: "carrier_proof",
      anchorId: "proof:1",
    });
    const providerRejectedClaim = settleRejected(settlement, claim, {
      rejectionKind: "provider_rejected",
      rejectionId: "provider:1",
      reason: "provider_rejected",
    });

    expect(
      validateBoundaryEventPayload(contract, "slot.ledgered", {
        claim: carrierProofClaim,
      }),
    ).toMatchObject({ issue: "claim_settlement_invalid" });
    expect(
      validateBoundaryEventPayload(contract, "slot.denied", {
        claim: providerRejectedClaim,
      }),
    ).toMatchObject({ issue: "claim_settlement_invalid" });
  });
});
