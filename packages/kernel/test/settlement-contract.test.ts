import { describe, expect, it } from "vite-plus/test";

import { makePreClaim } from "../src/effect-claim";
import type { Authored, Live, Recordable, Untrusted } from "../src";
import { captureLive } from "../src/live-edge";
import {
  defineSettlementContract,
  isSymbolicSettlementValue,
  settleLived,
  settleRejected,
  symbolicSettlementRef,
  validateSettlementContract,
  validateTerminalClaim,
} from "../src/settlement-contract";
import { untrustedValue } from "../src/value-brands";

describe("SettlementContract", () => {
  const contract = defineSettlementContract({
    settlementId: "example",
    anchorKinds: ["carrier_proof"],
    rejectionKinds: ["policy_denied"],
  });

  const claim = makePreClaim({
    operationRef: "example:op",
    scopeRef: { kind: "conversation", scopeId: "thread:1" },
    effectAuthorityRef: { authorityId: "example.record", authorityClass: "effect" },
    originRef: { originId: "example", originKind: "test" },
  });

  it("validates settlement contract vocabulary", () => {
    const authoredContract: Authored<typeof contract.value> = contract;
    expect(authoredContract.value.settlementId).toBe("example");
    expect(Object.prototype.propertyIsEnumerable.call(contract, "value")).toBe(false);
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
    const recordableLived: Recordable<typeof lived.value> = lived;
    expect(recordableLived.value.anchorRef.anchorId).toBe("proof:ok");
    expect(Object.prototype.propertyIsEnumerable.call(lived, "value")).toBe(false);
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
    const recordableRejected: Recordable<typeof rejected.value> = rejected;
    expect(recordableRejected.value.rejectionRef.rejectionId).toBe("policy:1");
    expect(Object.prototype.propertyIsEnumerable.call(rejected, "value")).toBe(false);
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

  it("does not let Untrusted or Live values escape as terminal settlement truth", () => {
    const livedShape = {
      phase: "lived" as const,
      operationRef: claim.operationRef,
      scopeRef: claim.scopeRef,
      effectAuthorityRef: claim.effectAuthorityRef,
      originRef: claim.originRef,
      anchorRef: {
        anchorId: "proof:ok",
        anchorKind: "carrier_proof" as const,
      },
    };
    const untrustedLived = untrustedValue(livedShape);
    const liveLived = captureLive(livedShape);

    const assertTypeErrors = () => {
      // @ts-expect-error Untrusted terminal shape is not owner-accepted Recordable truth.
      const recordableFromUntrusted: Recordable<typeof livedShape> = untrustedLived;
      // @ts-expect-error Live terminal material is not a claim shape.
      const claimFromLive: typeof livedShape = liveLived;
      // @ts-expect-error Live terminal material is not owner-accepted Recordable truth.
      const recordableFromLive: Recordable<typeof livedShape> = liveLived;
      const untrustedEvidence: Untrusted<typeof livedShape> = untrustedLived;
      const liveEvidence: Live<typeof livedShape> = liveLived;
      return [
        recordableFromUntrusted,
        claimFromLive,
        recordableFromLive,
        untrustedEvidence,
        liveEvidence,
      ];
    };

    expect(typeof assertTypeErrors).toBe("function");
    expect(validateTerminalClaim(contract, untrustedLived)).toMatchObject({ ok: true });
    expect(validateTerminalClaim(contract, liveLived)).toEqual({
      ok: false,
      issues: ["claim_invalid"],
    });
  });
});
