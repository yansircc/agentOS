import {
  DEPLOY_EVENTS,
  commitDeployFailed,
  deployCloudflareExtensionPackage,
  projectDeploy,
} from "../src";
import { makePreClaim, settleLivedClaim, settleRejectedClaim } from "@agent-os/core/effect-claim";
import type { ExtensionCapability } from "@agent-os/core/extensions";

const deployClaim = makePreClaim({
  operationRef: "deploy:session-1:promote",
  scopeRef: { kind: "external", scopeId: "site/acme", systemRef: "cloudflare" },
  authorityRef: {
    authorityId: "@agent-os/deploy-cloudflare.promote",
    authorityClass: "deploy",
  },
  originRef: {
    originId: "@agent-os/deploy-cloudflare",
    originKind: "extension_package",
  },
});
const livedDeployClaim = (anchorId: string) =>
  settleLivedClaim(deployClaim, {
    anchorId,
    anchorKind: "carrier_proof",
    carrierRef: "deploy-cloudflare",
  });

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
          claim: livedDeployClaim("https://ch-1.staging.example"),
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
          claim: livedDeployClaim("cf-deploy://v2"),
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
          claim: livedDeployClaim("proof://readback/v2"),
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

  it("settles deploy.* facts through ExtensionCapability", async () => {
    const committed: Array<{ event: string; data: unknown }> = [];
    const cap: ExtensionCapability = {
      packageId: "@agent-os/deploy-cloudflare",
      kindPrefixes: ["deploy."],
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
      commitDeployFailed(cap, {
        subjectRef: "session:1",
        step: "promote",
        proofRef: "proof://deploy/1",
        reason: "readback failed",
        claim: settleRejectedClaim(deployClaim, {
          rejectionId: "proof://deploy/1",
          rejectionKind: "provider_rejected",
          reason: "readback failed",
        }),
      }),
    ).resolves.toEqual({ id: 1 });

    expect(committed).toEqual([
      {
        event: DEPLOY_EVENTS.FAILED,
        data: {
          subjectRef: "session:1",
          step: "promote",
          proofRef: "proof://deploy/1",
          reason: "readback failed",
          claim: {
            phase: "rejected",
            operationRef: "deploy:session-1:promote",
            scopeRef: {
              kind: "external",
              scopeId: "site/acme",
              systemRef: "cloudflare",
            },
            authorityRef: {
              authorityId: "@agent-os/deploy-cloudflare.promote",
              authorityClass: "deploy",
            },
            originRef: {
              originId: "@agent-os/deploy-cloudflare",
              originKind: "extension_package",
            },
            rejectionRef: {
              rejectionId: "proof://deploy/1",
              rejectionKind: "provider_rejected",
              reason: "readback failed",
            },
          },
        },
      },
    ]);
  });
});
