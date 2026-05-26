import {
  VERIFICATION_EVENTS,
  projectVerificationGates,
  verificationExtensionPackage,
} from "../src";

describe("@agent-os/verification", () => {
  it("declares verification.* as an extension-owned prefix", () => {
    expect(verificationExtensionPackage("0.1.0")).toEqual({
      packageId: "@agent-os/verification",
      kindPrefixes: ["verification."],
      version: "0.1.0",
    });
  });

  it("projects readiness from latest required gate facts", () => {
    const events = [
      {
        id: 1,
        kind: VERIFICATION_EVENTS.GATE_RECORDED,
        payload: {
          subjectRef: "change:1",
          gate: "build",
          status: "passed",
          proofRef: "proof://build/1",
          fingerprint: "build/v1",
        },
      },
      {
        id: 2,
        kind: VERIFICATION_EVENTS.GATE_RECORDED,
        payload: {
          subjectRef: "change:1",
          gate: "typecheck",
          status: "failed",
          proofRef: "proof://typecheck/1",
          fingerprint: "typecheck/v1",
        },
      },
      {
        id: 3,
        kind: VERIFICATION_EVENTS.GATE_RECORDED,
        payload: {
          subjectRef: "change:1",
          gate: "typecheck",
          status: "passed",
          proofRef: "proof://typecheck/2",
          fingerprint: "typecheck/v2",
        },
      },
    ] as const;

    const projection = projectVerificationGates(events, "change:1", [
      "typecheck",
      "build",
    ]);

    expect(projection.ready).toBe(true);
    expect(projection.missing).toEqual([]);
    expect(projection.failed).toEqual([]);
    expect(projection.gateEventIds).toEqual([1, 3]);
  });
});
