import {
  CLOUDFLARE_RESOURCE_AUTHORITIES,
  CLOUDFLARE_RESOURCE_EVENTS,
  cloudflareResourceAuthorityContracts,
  cloudflareResourceExtensionPackage,
  commitCloudflareResourceFailed,
  projectCloudflareResource,
} from "../src";
import { makePreClaim, settleLivedClaim, settleRejectedClaim } from "@agent-os/core/effect-claim";
import type { ExtensionCapability } from "@agent-os/core/extensions";
import { bindingMaterialRef, externalResourceMaterialRef } from "@agent-os/core/material-ref";

const accountRef = externalResourceMaterialRef({
  provider: "cloudflare",
  resourceKind: "account",
  ref: "account/acme",
});

const d1ResourceRef = externalResourceMaterialRef({
  provider: "cloudflare",
  resourceKind: "d1",
  ref: "database/main",
});

const d1BindingRef = bindingMaterialRef({
  provider: "cloudflare",
  bindingKind: "d1",
  ref: "DB",
});

const cloudflareResourceClaim = (step: string) =>
  makePreClaim({
    operationRef: `cf-resource:subject-1:${step}`,
    scopeRef: { kind: "external", scopeId: "cf/account/acme/d1/main", systemRef: "cloudflare" },
    authorityRef:
      step === "provision"
        ? CLOUDFLARE_RESOURCE_AUTHORITIES.PROVISION
        : step === "bind"
          ? CLOUDFLARE_RESOURCE_AUTHORITIES.BIND
          : step === "destroy"
            ? CLOUDFLARE_RESOURCE_AUTHORITIES.DESTROY
            : CLOUDFLARE_RESOURCE_AUTHORITIES.MUTATE,
    originRef: {
      originId: "@agent-os/cloudflare-resource",
      originKind: "extension_package",
    },
  });

const livedCloudflareResourceClaim = (step: string, anchorId: string) =>
  settleLivedClaim(cloudflareResourceClaim(step), {
    anchorId,
    anchorKind: "carrier_proof",
    carrierRef: "cloudflare-resource",
  });

const rejectedCloudflareResourceClaim = settleRejectedClaim(cloudflareResourceClaim("mutate"), {
  rejectionId: "proof://cf/d1/failed",
  rejectionKind: "provider_rejected",
  reason: "D1 rejected statement",
});

const legacyCloudflareResourceClaim = makePreClaim({
  operationRef: "cf-resource:legacy:mutate",
  scopeRef: { kind: "external", scopeId: "cf/account/acme/d1/main", systemRef: "cloudflare" },
  authorityRef: CLOUDFLARE_RESOURCE_AUTHORITIES.MUTATE,
  originRef: {
    originId: "@agent-os/cloudflare-resource",
    originKind: "extension_package",
  },
});

describe("@agent-os/cloudflare-resource", () => {
  it("declares cf_resource.* as an extension-owned prefix", () => {
    expect(cloudflareResourceExtensionPackage("0.1.0")).toEqual({
      packageId: "@agent-os/cloudflare-resource",
      kindPrefixes: ["cf_resource."],
      version: "0.1.0",
    });
  });

  it("declares required material contracts without concrete refs", () => {
    expect(cloudflareResourceAuthorityContracts).toEqual([
      {
        authorityRef: CLOUDFLARE_RESOURCE_AUTHORITIES.PROVISION,
        requiredMaterials: [
          {
            slot: "api_token",
            kind: "credential",
            provider: "cloudflare",
            purpose: "cloudflare_api",
            required: true,
          },
          {
            slot: "account",
            kind: "external_resource",
            provider: "cloudflare",
            resourceKind: "account",
            required: true,
          },
        ],
      },
      {
        authorityRef: CLOUDFLARE_RESOURCE_AUTHORITIES.BIND,
        requiredMaterials: expect.arrayContaining([
          expect.objectContaining({ slot: "binding", kind: "binding", required: true }),
        ]),
      },
      {
        authorityRef: CLOUDFLARE_RESOURCE_AUTHORITIES.MUTATE,
        requiredMaterials: expect.arrayContaining([
          expect.objectContaining({ slot: "binding", kind: "binding", required: true }),
        ]),
      },
      {
        authorityRef: CLOUDFLARE_RESOURCE_AUTHORITIES.DESTROY,
        requiredMaterials: expect.not.arrayContaining([
          expect.objectContaining({ slot: "binding" }),
        ]),
      },
    ]);
  });

  it("projects lifecycle and latest mutation by subject ref", () => {
    const events = [
      {
        id: 1,
        kind: CLOUDFLARE_RESOURCE_EVENTS.RESOURCE_PROVISIONED,
        payload: {
          subjectRef: "res-1",
          resourceKind: "d1",
          resourceRef: d1ResourceRef,
          accountRef,
          proofRef: "proof://cf/d1/provision",
          claim: livedCloudflareResourceClaim("provision", "proof://cf/d1/provision"),
        },
      },
      {
        id: 2,
        kind: CLOUDFLARE_RESOURCE_EVENTS.RESOURCE_BOUND,
        payload: {
          subjectRef: "res-1",
          resourceRef: d1ResourceRef,
          bindingRef: d1BindingRef,
          proofRef: "proof://cf/d1/bind",
          claim: livedCloudflareResourceClaim("bind", "proof://cf/d1/bind"),
        },
      },
      {
        id: 3,
        kind: CLOUDFLARE_RESOURCE_EVENTS.MUTATION_RECORDED,
        payload: {
          subjectRef: "res-1",
          resourceRef: d1BindingRef,
          mutationKind: "d1.exec",
          mutationRef: "mutation://d1/001",
          proofRef: "proof://cf/d1/exec/001",
          fingerprint: "sha256:abc",
          claim: livedCloudflareResourceClaim("mutate", "proof://cf/d1/exec/001"),
        },
      },
      {
        id: 4,
        kind: CLOUDFLARE_RESOURCE_EVENTS.MUTATION_RECORDED,
        payload: {
          subjectRef: "res-1",
          resourceRef: d1BindingRef,
          mutationKind: "d1.exec",
          mutationRef: "mutation://d1/002",
          proofRef: "proof://cf/d1/exec/002",
          fingerprint: "sha256:def",
          claim: livedCloudflareResourceClaim("mutate", "proof://cf/d1/exec/002"),
        },
      },
    ] as const;

    expect(projectCloudflareResource(events, "res-1")).toEqual({
      subjectRef: "res-1",
      status: "mutated",
      lastEventKind: CLOUDFLARE_RESOURCE_EVENTS.MUTATION_RECORDED,
      resourceKind: "d1",
      resourceRef: d1BindingRef,
      accountRef,
      bindingRef: d1BindingRef,
      latestMutation: {
        eventId: 4,
        subjectRef: "res-1",
        resourceRef: d1BindingRef,
        mutationKind: "d1.exec",
        mutationRef: "mutation://d1/002",
        proofRef: "proof://cf/d1/exec/002",
        fingerprint: "sha256:def",
        claim: livedCloudflareResourceClaim("mutate", "proof://cf/d1/exec/002"),
      },
      mutationEventIds: [3, 4],
      failure: undefined,
    });
  });

  it("ignores resolved material and raw bytes because payloads require symbolic refs", () => {
    const events = [
      {
        id: 1,
        kind: CLOUDFLARE_RESOURCE_EVENTS.MUTATION_RECORDED,
        payload: {
          subjectRef: "res-raw",
          resourceRef: { rawBinding: {} },
          mutationKind: "r2.put",
          mutationRef: "mutation://r2/put",
          proofRef: "proof://r2/put",
          rawBytes: new Uint8Array([1, 2, 3]),
        },
      },
    ] as const;

    expect(projectCloudflareResource(events, "res-raw")).toEqual({
      subjectRef: "res-raw",
      status: "missing",
      lastEventKind: undefined,
      resourceKind: undefined,
      resourceRef: undefined,
      accountRef: undefined,
      bindingRef: undefined,
      latestMutation: undefined,
      mutationEventIds: [],
      failure: undefined,
    });
  });

  it("settles cf_resource.* failure facts through ExtensionCapability", async () => {
    const committed: Array<{ event: string; data: unknown }> = [];
    const cap: ExtensionCapability = {
      packageId: "@agent-os/cloudflare-resource",
      kindPrefixes: ["cf_resource."],
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
      commitCloudflareResourceFailed(cap, {
        subjectRef: "res-1",
        step: "mutate",
        proofRef: "proof://cf/d1/failed",
        reason: "D1 rejected statement",
        claim: rejectedCloudflareResourceClaim,
      }),
    ).resolves.toEqual({ id: 1 });

    expect(committed).toEqual([
      {
        event: CLOUDFLARE_RESOURCE_EVENTS.FAILED,
        data: {
          subjectRef: "res-1",
          step: "mutate",
          proofRef: "proof://cf/d1/failed",
          reason: "D1 rejected statement",
          claim: {
            phase: "rejected",
            operationRef: "cf-resource:subject-1:mutate",
            scopeRef: {
              kind: "external",
              scopeId: "cf/account/acme/d1/main",
              systemRef: "cloudflare",
            },
            authorityRef: CLOUDFLARE_RESOURCE_AUTHORITIES.MUTATE,
            originRef: {
              originId: "@agent-os/cloudflare-resource",
              originKind: "extension_package",
            },
            rejectionRef: {
              rejectionId: "proof://cf/d1/failed",
              rejectionKind: "provider_rejected",
              reason: "D1 rejected statement",
            },
          },
        },
      },
    ]);
  });

  it("skips carrier facts that do not settle a claim", () => {
    const events = [
      {
        id: 1,
        kind: CLOUDFLARE_RESOURCE_EVENTS.MUTATION_RECORDED,
        payload: {
          subjectRef: "res-unsettled",
          resourceRef: d1BindingRef,
          mutationKind: "d1.exec",
          mutationRef: "mutation://d1/unsettled",
          proofRef: "proof://cf/d1/unsettled",
        },
      },
      {
        id: 2,
        kind: CLOUDFLARE_RESOURCE_EVENTS.MUTATION_RECORDED,
        payload: {
          subjectRef: "res-unsettled",
          resourceRef: d1BindingRef,
          mutationKind: "d1.exec",
          mutationRef: "mutation://d1/preclaim",
          proofRef: "proof://cf/d1/preclaim",
          claim: legacyCloudflareResourceClaim,
        },
      },
    ] as const;

    expect(projectCloudflareResource(events, "res-unsettled")).toEqual({
      subjectRef: "res-unsettled",
      status: "missing",
      lastEventKind: undefined,
      resourceKind: undefined,
      resourceRef: undefined,
      accountRef: undefined,
      bindingRef: undefined,
      latestMutation: undefined,
      mutationEventIds: [],
      failure: undefined,
    });
  });
});
