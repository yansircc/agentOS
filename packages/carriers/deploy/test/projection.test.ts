import {
  DEPLOY_EVENTS,
  DEPLOY_KIND,
  deployCarrier,
  deployBoundaryPackage,
  deploySettlementRef,
  projectDeploy,
  settleDeployLived,
  settleDeployRejected,
} from "../src";
import { makePreClaim } from "@agent-os/core/effect-claim";
import { makeCommitters, type ExtensionCapability } from "@agent-os/core/extensions";

const deployClaim = makePreClaim({
  operationRef: "deploy:session-1:promote",
  scopeRef: { kind: "external", scopeId: "site/acme", systemRef: "cloudflare" },
  effectAuthorityRef: {
    authorityId: "@agent-os/deploy.promote",
    authorityClass: "deploy",
  },
  originRef: {
    originId: "@agent-os/deploy",
    originKind: "extension_package",
  },
});
const livedDeployClaim = (anchorId: string) =>
  settleDeployLived(deployClaim, {
    proofRef: deploySettlementRef(anchorId),
    carrierRef: "deploy",
  });

const deployRefs = {
  artifact: deploySettlementRef("artifact", "ch-1"),
  preview: deploySettlementRef("preview", "ch-1"),
  deployV1: deploySettlementRef("version", "v1"),
  deployV2: deploySettlementRef("version", "v2"),
  production: deploySettlementRef("production", "site"),
  readbackV2: deploySettlementRef("readback", "v2"),
} as const;

describe("@agent-os/deploy", () => {
  it("declares deploy.* as an extension-owned prefix", () => {
    expect(deployBoundaryPackage("0.1.0")).toMatchObject({
      packageId: "@agent-os/deploy",
      kindPrefixes: ["deploy."],
      version: "0.1.0",
    });
  });

  it("projects preview, promotion, and readback by subject ref", () => {
    const events = [
      {
        id: 1,
        kind: DEPLOY_KIND.PREVIEW_RECORDED,
        payload: {
          subjectRef: "ch-1",
          previewRef: deployRefs.preview,
          artifactRef: deployRefs.artifact,
          claim: livedDeployClaim(deployRefs.preview),
        },
      },
      {
        id: 2,
        kind: DEPLOY_KIND.PRODUCTION_PROMOTED,
        payload: {
          subjectRef: "ch-1",
          deployRef: deployRefs.deployV2,
          productionRef: deployRefs.production,
          rollbackRef: deployRefs.deployV1,
          claim: livedDeployClaim(deployRefs.deployV2),
        },
      },
      {
        id: 3,
        kind: DEPLOY_KIND.PRODUCTION_READBACK,
        payload: {
          subjectRef: "ch-1",
          productionRef: deployRefs.production,
          readbackRef: deployRefs.readbackV2,
          status: "passed",
          claim: livedDeployClaim(deployRefs.readbackV2),
        },
      },
    ] as const;

    expect(JSON.stringify(events)).not.toMatch(/[a-z][a-z0-9+.-]*:\/\//i);
    expect(projectDeploy(events, "ch-1")).toEqual({
      subjectRef: "ch-1",
      previewRef: deployRefs.preview,
      artifactRef: deployRefs.artifact,
      deployRef: deployRefs.deployV2,
      productionRef: deployRefs.production,
      readbackRef: deployRefs.readbackV2,
      rollbackRef: deployRefs.deployV1,
      status: "live_verified",
      failure: undefined,
    });
  });

  it("rejects URL-shaped deploy refs at the carrier decode boundary", () => {
    const cases = [
      {
        event: DEPLOY_KIND.PREVIEW_RECORDED,
        payload: {
          subjectRef: "ch-url",
          previewRef: "https://ch-url.staging.example",
          artifactRef: deploySettlementRef("artifact", "ch-url"),
          claim: livedDeployClaim(deploySettlementRef("preview", "ch-url")),
        },
      },
      {
        event: DEPLOY_KIND.PREVIEW_RECORDED,
        payload: {
          subjectRef: "ch-url",
          previewRef: deploySettlementRef("preview", "ch-url"),
          artifactRef: "r2://deploy/ch-url",
          claim: livedDeployClaim(deploySettlementRef("preview", "ch-url")),
        },
      },
      {
        event: DEPLOY_KIND.PRODUCTION_PROMOTED,
        payload: {
          subjectRef: "ch-url",
          deployRef: deploySettlementRef("version", "ch-url", "v1"),
          productionRef: "https://site.example",
          claim: livedDeployClaim(deploySettlementRef("version", "ch-url", "v1")),
        },
      },
      {
        event: DEPLOY_KIND.PRODUCTION_READBACK,
        payload: {
          subjectRef: "ch-url",
          productionRef: deploySettlementRef("production", "site"),
          readbackRef: "https://site.example/readback",
          status: "passed",
          claim: livedDeployClaim(deploySettlementRef("readback", "ch-url")),
        },
      },
      {
        event: DEPLOY_KIND.ROLLBACK_RECORDED,
        payload: {
          subjectRef: "ch-url",
          rollbackRef: "https://site.example/rollback",
          restoredDeployRef: deploySettlementRef("version", "ch-url", "v1"),
          claim: livedDeployClaim(deploySettlementRef("rollback", "ch-url")),
        },
      },
      {
        event: DEPLOY_KIND.FAILED,
        payload: {
          subjectRef: "ch-url",
          step: "promote",
          proofRef: "https://site.example/failure",
          reason: "provider returned a URL",
          claim: settleDeployRejected(deployClaim, {
            proofRef: deploySettlementRef("failure", "ch-url"),
            rejectionKind: "provider_rejected",
            reason: "provider_returned_url",
          }),
        },
      },
    ] as const;

    for (const { event, payload } of cases) {
      expect(() => deployCarrier.decode(event, payload)).toThrow(/payload violates schema/);
    }
  });

  it("does not promote production from a promotion without a preview", () => {
    const events = [
      {
        id: 1,
        kind: DEPLOY_KIND.PRODUCTION_PROMOTED,
        payload: {
          subjectRef: "ch-lone-promotion",
          deployRef: deployRefs.deployV2,
          productionRef: deployRefs.production,
          rollbackRef: deployRefs.deployV1,
          claim: livedDeployClaim(deployRefs.deployV2),
        },
      },
    ] as const;

    expect(projectDeploy(events, "ch-lone-promotion")).toEqual({
      subjectRef: "ch-lone-promotion",
      previewRef: undefined,
      artifactRef: undefined,
      deployRef: undefined,
      productionRef: undefined,
      readbackRef: undefined,
      rollbackRef: undefined,
      status: "missing",
      failure: undefined,
    });
  });

  it("settles deploy.* facts through ExtensionCapability", async () => {
    const committed: Array<{ event: string; data: unknown }> = [];
    const cap: ExtensionCapability = {
      ownerId: "@agent-os/deploy",
      sourcePackageName: "@agent-os/deploy",
      packageId: "@agent-os/deploy",
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
      makeCommitters(DEPLOY_EVENTS, cap)[DEPLOY_KIND.FAILED]({
        subjectRef: "session:1",
        step: "promote",
        proofRef: deploySettlementRef("deploy", "1"),
        reason: "readback failed",
        claim: settleDeployRejected(deployClaim, {
          proofRef: deploySettlementRef("deploy", "1"),
          rejectionKind: "provider_rejected",
          reason: "readback_failed",
        }),
      }),
    ).resolves.toEqual({ id: 1 });

    expect(committed).toEqual([
      {
        event: DEPLOY_KIND.FAILED,
        data: {
          subjectRef: "session:1",
          step: "promote",
          proofRef: deploySettlementRef("deploy", "1"),
          reason: "readback failed",
          claim: {
            phase: "rejected",
            operationRef: "deploy:session-1:promote",
            scopeRef: {
              kind: "external",
              scopeId: "site/acme",
              systemRef: "cloudflare",
            },
            effectAuthorityRef: {
              authorityId: "@agent-os/deploy.promote",
              authorityClass: "deploy",
            },
            originRef: {
              originId: "@agent-os/deploy",
              originKind: "extension_package",
            },
            rejectionRef: {
              rejectionId: deploySettlementRef("deploy", "1"),
              rejectionKind: "provider_rejected",
              reason: "readback_failed",
            },
          },
        },
      },
    ]);
  });
});
