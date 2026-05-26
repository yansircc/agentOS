import { describe, expect, it } from "@effect/vitest";

import { IMAGE_EVENTS, projectImageJobs } from "../src";

describe("image job projection", () => {
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
