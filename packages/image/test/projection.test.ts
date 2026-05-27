import { describe, expect, it } from "vite-plus/test";

import { IMAGE_EVENT_PREFIX, IMAGE_EVENTS, imageExtensionPackage, projectImageJobs } from "../src";

describe("image job projection", () => {
  it("declares image.* as an extension-owned prefix, not core vocabulary", () => {
    expect(imageExtensionPackage("0.1.0")).toEqual({
      packageId: "@agent-os/image",
      kindPrefixes: [IMAGE_EVENT_PREFIX],
      version: "0.1.0",
    });
  });

  it("projects image job events without owning a second job store", () => {
    const projection = projectImageJobs([
      {
        kind: IMAGE_EVENTS.JOB_REQUESTED,
        payload: { jobId: "job-1" },
      },
      {
        kind: IMAGE_EVENTS.PROVIDER_COMPLETED,
        payload: { jobId: "job-1" },
      },
      {
        kind: IMAGE_EVENTS.ARTIFACT_MATERIALIZED,
        payload: { jobId: "job-1", artifactRef: { carrier: "r2", key: "a" } },
      },
    ]);

    expect(projection.get("job-1")).toEqual({
      jobId: "job-1",
      status: "materialized",
      artifacts: [{ carrier: "r2", key: "a" }],
    });
  });
});
