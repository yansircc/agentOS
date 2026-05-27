import {
  STAGING_EVENTS,
  deferStagingArtifactReap,
  projectStagingArtifact,
  stagingArtifactExtensionPackage,
} from "../src";
import { makePreClaim, settleLivedClaim } from "@agent-os/core/effect-claim";
import type { ExtensionCapability } from "@agent-os/core/extensions";

const stagingClaim = makePreClaim({
  operationRef: "staging:session-1:reap",
  scopeRef: { kind: "artifact", scopeId: "artifact/session-1" },
  authorityRef: {
    authorityId: "@agent-os/staging-artifact.reap",
    authorityClass: "effect",
  },
  originRef: {
    originId: "@agent-os/staging-artifact",
    originKind: "extension_package",
  },
});

describe("@agent-os/staging-artifact", () => {
  it("declares staging.* as an extension-owned prefix", () => {
    expect(stagingArtifactExtensionPackage("0.1.0")).toEqual({
      packageId: "@agent-os/staging-artifact",
      kindPrefixes: ["staging."],
      version: "0.1.0",
    });
  });

  it("projects publish and reap state by subject ref", () => {
    const events = [
      {
        id: 1,
        kind: STAGING_EVENTS.ARTIFACT_PUBLISHED,
        payload: {
          subjectRef: "ch-1",
          artifactRef: "r2://staging/ch-1",
          routeRef: "https://ch-1.staging.example",
          digest: "sha256:abc",
        },
      },
      {
        id: 2,
        kind: STAGING_EVENTS.ARTIFACT_REAPED,
        payload: {
          subjectRef: "ch-1",
          artifactRef: "r2://staging/ch-1",
          reason: "published",
        },
      },
    ] as const;

    expect(projectStagingArtifact(events, "ch-1")).toEqual({
      subjectRef: "ch-1",
      artifactRef: "r2://staging/ch-1",
      routeRef: "https://ch-1.staging.example",
      digest: "sha256:abc",
      status: "reaped",
      reapedReason: "published",
    });
  });

  it("defers staging.* facts through ExtensionCapability time()", async () => {
    const deferred: Array<{ event: string; data: unknown; at?: number }> = [];
    const cap: ExtensionCapability = {
      packageId: "@agent-os/staging-artifact",
      kindPrefixes: ["staging."],
      version: "0.1.0",
      commit: async (spec) => {
        deferred.push(spec);
        return { id: deferred.length };
      },
      time: async (spec) => {
        deferred.push(spec);
        return { id: deferred.length };
      },
    };

    await expect(
      deferStagingArtifactReap(cap, 42, {
        subjectRef: "session:1",
        artifactRef: "r2://staging/session-1",
        reason: "expired",
        claim: settleLivedClaim(stagingClaim, {
          anchorId: "r2://staging/session-1",
          anchorKind: "carrier_proof",
          carrierRef: "staging-artifact",
        }),
      }),
    ).resolves.toEqual({ id: 1 });

    expect(deferred).toEqual([
      {
        at: 42,
        event: STAGING_EVENTS.ARTIFACT_REAPED,
        data: {
          subjectRef: "session:1",
          artifactRef: "r2://staging/session-1",
          reason: "expired",
          claim: {
            phase: "lived",
            operationRef: "staging:session-1:reap",
            scopeRef: { kind: "artifact", scopeId: "artifact/session-1" },
            authorityRef: {
              authorityId: "@agent-os/staging-artifact.reap",
              authorityClass: "effect",
            },
            originRef: {
              originId: "@agent-os/staging-artifact",
              originKind: "extension_package",
            },
            anchorRef: {
              anchorId: "r2://staging/session-1",
              anchorKind: "carrier_proof",
              carrierRef: "staging-artifact",
            },
          },
        },
      },
    ]);
  });
});
