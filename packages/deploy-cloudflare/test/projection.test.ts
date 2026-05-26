import {
  DEPLOY_EVENTS,
  deployCloudflareExtensionPackage,
  projectDeploy,
} from "../src";

describe("@agent-os/deploy-cloudflare", () => {
  it("declares deploy.* as an extension-owned prefix", () => {
    expect(deployCloudflareExtensionPackage("0.1.0")).toEqual({
      packageId: "@agent-os/deploy-cloudflare",
      kindPrefixes: ["deploy."],
      version: "0.1.0",
    });
  });

  it("projects preview, promotion, and readback by subject ref", () => {
    const events = [
      {
        id: 1,
        kind: DEPLOY_EVENTS.PREVIEW_RECORDED,
        payload: {
          subjectRef: "ch-1",
          previewRef: "https://ch-1.staging.example",
          artifactRef: "r2://staging/ch-1",
        },
      },
      {
        id: 2,
        kind: DEPLOY_EVENTS.PRODUCTION_PROMOTED,
        payload: {
          subjectRef: "ch-1",
          deployRef: "cf-deploy://v2",
          productionRef: "https://site.example",
          rollbackRef: "cf-deploy://v1",
        },
      },
      {
        id: 3,
        kind: DEPLOY_EVENTS.PRODUCTION_READBACK,
        payload: {
          subjectRef: "ch-1",
          productionRef: "https://site.example",
          readbackRef: "proof://readback/v2",
          status: "passed",
        },
      },
    ] as const;

    expect(projectDeploy(events, "ch-1")).toEqual({
      subjectRef: "ch-1",
      previewRef: "https://ch-1.staging.example",
      artifactRef: "r2://staging/ch-1",
      deployRef: "cf-deploy://v2",
      productionRef: "https://site.example",
      readbackRef: "proof://readback/v2",
      rollbackRef: "cf-deploy://v1",
      status: "live_verified",
      failure: undefined,
    });
  });
});
