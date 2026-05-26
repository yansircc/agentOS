import {
  STAGING_EVENTS,
  projectStagingArtifact,
  stagingArtifactExtensionPackage,
} from "../src";

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
});
