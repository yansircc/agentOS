import { describe, expect, it } from "vite-plus/test";

import { makePreClaim } from "../src/effect-claim";
import {
  defineSettlementContract,
  isSymbolicSettlementValue,
  settleLived,
  settleRejected,
  symbolicSettlementRef,
  validateSettlementContract,
  validateTerminalClaim,
} from "../src/settlement-contract";

describe("SettlementContract", () => {
  const contract = defineSettlementContract({
    settlementId: "example",
    anchorKinds: ["carrier_proof"],
    rejectionKinds: ["policy_denied"],
  });

  const claim = makePreClaim({
    operationRef: "example:op",
    scopeRef: { kind: "conversation", scopeId: "thread:1" },
    authorityRef: { authorityId: "example.record", authorityClass: "effect" },
    originRef: { originId: "example", originKind: "test" },
  });

  it("validates settlement contract vocabulary", () => {
    expect(validateSettlementContract(contract)).toEqual({ ok: true, contract });
    expect(
      validateSettlementContract({
        settlementId: "broken",
        anchorKinds: ["carrier_proof", "not_anchor"],
        rejectionKinds: ["policy_denied", "not_rejection"],
      }),
    ).toEqual({
      ok: false,
      issues: ["anchor_kinds_invalid", "rejection_kinds_invalid"],
    });
  });

  it("owns the symbolic terminal value predicate", () => {
    expect(isSymbolicSettlementValue("proof:cloudflare.d1:ok-1")).toBe(true);
    expect(isSymbolicSettlementValue("proof://cloudflare/d1")).toBe(false);
    expect(isSymbolicSettlementValue("")).toBe(false);
    expect(symbolicSettlementRef("proof", ["thread/t1", "intent 1"])).toBe(
      "proof:thread_x002ft1:intent_x00201",
    );
  });

  it("constructs lived terminal claims only through contract vocabulary", () => {
    const lived = settleLived(contract, claim, {
      anchorId: "proof:ok",
      anchorKind: "carrier_proof",
      carrierRef: "resource:cloudflare",
    });

    expect(validateTerminalClaim(contract, lived)).toEqual({ ok: true, claim: lived });
    expect(() =>
      settleLived(contract, claim, {
        anchorId: "proof:ok",
        anchorKind: "ledger_event",
      }),
    ).toThrow(/anchor_kind_outside_contract/);
    expect(() =>
      settleLived(contract, claim, {
        anchorId: "proof://bad",
        anchorKind: "carrier_proof",
      }),
    ).toThrow(/anchor_id_not_symbolic/);
  });

  it("constructs rejected terminal claims only through contract vocabulary", () => {
    const rejected = settleRejected(contract, claim, {
      rejectionId: "policy:1",
      rejectionKind: "policy_denied",
      reason: "policy_denied",
    });

    expect(validateTerminalClaim(contract, rejected)).toEqual({
      ok: true,
      claim: rejected,
    });
    expect(() =>
      settleRejected(contract, claim, {
        rejectionId: "policy:1",
        rejectionKind: "provider_rejected",
      }),
    ).toThrow(/rejection_kind_outside_contract/);
    expect(() =>
      settleRejected(contract, claim, {
        rejectionId: "policy://bad",
        rejectionKind: "policy_denied",
      }),
    ).toThrow(/rejection_id_not_symbolic/);
    expect(() =>
      settleRejected(contract, claim, {
        rejectionId: "policy:1",
        rejectionKind: "policy_denied",
        reason: "not symbolic",
      }),
    ).toThrow(/reason_not_symbolic/);
  });

  it("rejects shape-valid terminal claims outside the contract", () => {
    expect(
      validateTerminalClaim(contract, {
        ...claim,
        phase: "lived",
        anchorRef: {
          anchorId: "proof:ok",
          anchorKind: "ledger_event",
        },
      }),
    ).toEqual({
      ok: false,
      issues: ["anchor_kind_outside_contract"],
    });
  });
});
