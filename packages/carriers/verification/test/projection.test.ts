import {
  VERIFICATION_EVENTS,
  VERIFICATION_KIND,
  projectVerificationGates,
  verificationBoundaryPackage,
  verificationSettlementRef,
  settleVerificationLived,
} from "../src";
import { makePreClaim } from "@agent-os/kernel/effect-claim";
import { makeCommitters, type ExtensionCapability } from "@agent-os/kernel/extensions";

const verificationClaim = makePreClaim({
  operationRef: "verification:subject-1:typecheck",
  scopeRef: { kind: "artifact", scopeId: "artifact/subject-1" },
  effectAuthorityRef: {
    authorityId: "@agent-os/verification.gate",
    authorityClass: "effect",
  },
  originRef: {
    originId: "@agent-os/verification",
    originKind: "extension_package",
  },
});
const livedVerificationClaim = (anchorId: string) =>
  settleVerificationLived(verificationClaim, {
    proofRef: anchorId,
    carrierRef: "verification",
  });

describe("@agent-os/verification", () => {
  it("declares verification.* as an extension-owned prefix", () => {
    expect(verificationBoundaryPackage("0.1.0")).toMatchObject({
      packageId: "@agent-os/verification",
      kindPrefixes: ["verification."],
      version: "0.1.0",
    });
  });

  it("projects readiness from latest required gate facts", () => {
    const events = [
      {
        id: 1,
        kind: VERIFICATION_KIND.GATE_RECORDED,
        payload: {
          subjectRef: "change:1",
          gate: "build",
          status: "passed",
          proofRef: verificationSettlementRef("build", "1"),
          fingerprint: "build/v1",
          claim: livedVerificationClaim(verificationSettlementRef("build", "1")),
        },
      },
      {
        id: 2,
        kind: VERIFICATION_KIND.GATE_RECORDED,
        payload: {
          subjectRef: "change:1",
          gate: "typecheck",
          status: "failed",
          proofRef: verificationSettlementRef("typecheck", "1"),
          fingerprint: "typecheck/v1",
          claim: livedVerificationClaim(verificationSettlementRef("typecheck", "1")),
        },
      },
      {
        id: 3,
        kind: VERIFICATION_KIND.GATE_RECORDED,
        payload: {
          subjectRef: "change:1",
          gate: "typecheck",
          status: "passed",
          proofRef: verificationSettlementRef("typecheck", "2"),
          fingerprint: "typecheck/v2",
          claim: livedVerificationClaim(verificationSettlementRef("typecheck", "2")),
        },
      },
    ] as const;

    const projection = projectVerificationGates(events, "change:1", ["typecheck", "build"]);

    expect(projection.ready).toBe(true);
    expect(projection.missing).toEqual([]);
    expect(projection.failed).toEqual([]);
    expect(projection.gateEventIds).toEqual([1, 3]);
  });

  it("settles verification.* facts through ExtensionCapability", async () => {
    const committed: Array<{ event: string; data: unknown }> = [];
    const cap: ExtensionCapability = {
      ownerId: "@agent-os/verification",
      sourcePackageName: "@agent-os/verification",
      packageId: "@agent-os/verification",
      kindPrefixes: ["verification."],
      version: "0.1.0",
      commit: async (spec) => {
        committed.push(spec);
        return { id: committed.length };
      },
      time: async (spec) => {
        committed.push(spec);
        return { id: committed.length };
      },
    };

    await expect(
      makeCommitters(VERIFICATION_EVENTS, cap)[VERIFICATION_KIND.GATE_RECORDED]({
        subjectRef: "subject-1",
        gate: "typecheck",
        status: "failed",
        proofRef: verificationSettlementRef("typecheck", "1"),
        fingerprint: "typecheck/v1",
        claim: livedVerificationClaim(verificationSettlementRef("typecheck", "1")),
      }),
    ).resolves.toEqual({ id: 1 });

    expect(committed).toEqual([
      {
        event: VERIFICATION_KIND.GATE_RECORDED,
        data: {
          subjectRef: "subject-1",
          gate: "typecheck",
          status: "failed",
          proofRef: verificationSettlementRef("typecheck", "1"),
          fingerprint: "typecheck/v1",
          claim: {
            phase: "lived",
            operationRef: "verification:subject-1:typecheck",
            scopeRef: { kind: "artifact", scopeId: "artifact/subject-1" },
            effectAuthorityRef: {
              authorityId: "@agent-os/verification.gate",
              authorityClass: "effect",
            },
            originRef: {
              originId: "@agent-os/verification",
              originKind: "extension_package",
            },
            anchorRef: {
              anchorId: verificationSettlementRef("typecheck", "1"),
              anchorKind: "carrier_proof",
              carrierRef: "verification",
            },
          },
        },
      },
    ]);
  });
});
