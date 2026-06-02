import {
  STAGING_KIND,
  projectStagingArtifact,
  stagingArtifactBoundaryPackage,
  stagingArtifactSettlementRef,
  settleStagingArtifactLived,
} from "../src";
import { makePreClaim } from "@agent-os/kernel/effect-claim";
import type { ExtensionCapability } from "@agent-os/kernel/extensions";

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
const livedStagingClaim = (anchorId: string) =>
  settleStagingArtifactLived(stagingClaim, {
    proofRef: stagingArtifactSettlementRef(anchorId),
    carrierRef: "staging-artifact",
  });

const stagingRefs = {
  artifact: stagingArtifactSettlementRef("artifact", "ch-1"),
  route: stagingArtifactSettlementRef("route", "ch-1"),
  reap: stagingArtifactSettlementRef("artifact", "ch-1", "reaped"),
  sessionArtifact: stagingArtifactSettlementRef("artifact", "session-1"),
} as const;

describe("@agent-os/staging-artifact", () => {
  it("declares staging.* as an extension-owned prefix", () => {
    expect(stagingArtifactBoundaryPackage("0.1.0")).toMatchObject({
      packageId: "@agent-os/staging-artifact",
      kindPrefixes: ["staging."],
      version: "0.1.0",
    });
  });

  it("projects publish and reap state by subject ref", () => {
    const events = [
      {
        id: 1,
        kind: STAGING_KIND.ARTIFACT_PUBLISHED,
        payload: {
          subjectRef: "ch-1",
          artifactRef: stagingRefs.artifact,
          routeRef: stagingRefs.route,
          digest: "sha256:abc",
          claim: livedStagingClaim(stagingRefs.artifact),
        },
      },
      {
        id: 2,
        kind: STAGING_KIND.ARTIFACT_REAPED,
        payload: {
          subjectRef: "ch-1",
          artifactRef: stagingRefs.artifact,
          reason: "published",
          claim: livedStagingClaim(stagingRefs.reap),
        },
      },
    ] as const;

    expect(JSON.stringify(events)).not.toMatch(/[a-z][a-z0-9+.-]*:\/\//i);
    expect(projectStagingArtifact(events, "ch-1")).toEqual({
      subjectRef: "ch-1",
      artifactRef: stagingRefs.artifact,
      routeRef: stagingRefs.route,
      digest: "sha256:abc",
      status: "reaped",
      reapedReason: "published",
    });
  });

  it("does not project scheme-shaped artifact or route refs", () => {
    const events = [
      {
        id: 1,
        kind: STAGING_KIND.ARTIFACT_PUBLISHED,
        payload: {
          subjectRef: "ch-url",
          artifactRef: "r2://staging/ch-url",
          routeRef: "https://ch-url.staging.example",
          digest: "sha256:bad",
          claim: livedStagingClaim(stagingArtifactSettlementRef("artifact", "ch-url")),
        },
      },
      {
        id: 2,
        kind: STAGING_KIND.ARTIFACT_PUBLISHED,
        payload: {
          subjectRef: "ch-url",
          artifactRef: stagingArtifactSettlementRef("artifact", "ch-url"),
          routeRef: stagingArtifactSettlementRef("route", "ch-url"),
          digest: "sha256:ok",
          claim: livedStagingClaim(stagingArtifactSettlementRef("artifact", "ch-url")),
        },
      },
      {
        id: 3,
        kind: STAGING_KIND.ARTIFACT_REAPED,
        payload: {
          subjectRef: "ch-url",
          artifactRef: "r2://staging/ch-url",
          reason: "published",
          claim: livedStagingClaim(stagingArtifactSettlementRef("artifact", "ch-url", "reaped")),
        },
      },
    ] as const;

    expect(projectStagingArtifact(events, "ch-url")).toEqual({
      subjectRef: "ch-url",
      artifactRef: stagingArtifactSettlementRef("artifact", "ch-url"),
      routeRef: stagingArtifactSettlementRef("route", "ch-url"),
      digest: "sha256:ok",
      status: "published",
      reapedReason: undefined,
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
      cap.time({
        at: 42,
        event: STAGING_KIND.ARTIFACT_REAPED,
        data: {
          subjectRef: "session:1",
          artifactRef: stagingRefs.sessionArtifact,
          reason: "expired",
          claim: livedStagingClaim(stagingRefs.sessionArtifact),
        },
      }),
    ).resolves.toEqual({ id: 1 });

    expect(deferred).toEqual([
      {
        at: 42,
        event: STAGING_KIND.ARTIFACT_REAPED,
        data: {
          subjectRef: "session:1",
          artifactRef: stagingRefs.sessionArtifact,
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
              anchorId: stagingArtifactSettlementRef(stagingRefs.sessionArtifact),
              anchorKind: "carrier_proof",
              carrierRef: "staging-artifact",
            },
          },
        },
      },
    ]);
  });
});
