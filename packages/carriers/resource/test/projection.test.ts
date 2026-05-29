import {
  RESOURCE_AUTHORITIES,
  RESOURCE_EVENTS,
  RESOURCE_KIND,
  resourceAuthorityContracts,
  resourceBoundaryPackage,
  resourceSettlementRef,
  projectResource,
  settleResourceLived,
  settleResourceRejected,
} from "../src";
import { makePreClaim } from "@agent-os/kernel/effect-claim";
import { makeCommitters, type ExtensionCapability } from "@agent-os/kernel/extensions";
import { bindingMaterialRef, externalResourceMaterialRef } from "@agent-os/kernel/material-ref";

const accountRef = externalResourceMaterialRef({
  provider: "resource-provider",
  resourceKind: "account",
  ref: "account/acme",
});

const resourceRef = externalResourceMaterialRef({
  provider: "resource-provider",
  resourceKind: "database",
  ref: "resource/main",
});

const resourceBindingRef = bindingMaterialRef({
  provider: "resource-provider",
  bindingKind: "database",
  ref: "DB",
});

const resourceClaim = (step: string) =>
  makePreClaim({
    operationRef: `resource:subject-1:${step}`,
    scopeRef: { kind: "external", scopeId: "resource/account/acme/main", systemRef: "resource" },
    authorityRef:
      step === "provision"
        ? RESOURCE_AUTHORITIES.PROVISION
        : step === "bind"
          ? RESOURCE_AUTHORITIES.BIND
          : step === "destroy"
            ? RESOURCE_AUTHORITIES.DESTROY
            : RESOURCE_AUTHORITIES.MUTATE,
    originRef: {
      originId: "@agent-os/resource-carrier",
      originKind: "extension_package",
    },
  });

const livedResourceClaim = (step: string, anchorId: string) =>
  settleResourceLived(resourceClaim(step), {
    proofRef: anchorId,
    carrierRef: "resource-carrier",
  });

const rejectedResourceProofRef = resourceSettlementRef("database", "failed");

const rejectedResourceClaim = settleResourceRejected(resourceClaim("mutate"), {
  code: "ProviderFailure",
  proofRef: rejectedResourceProofRef,
  rejectionKind: "provider_rejected",
  reason: "resource_rejected_statement",
});

const resourceProofRef = (...parts: ReadonlyArray<string | number>): string =>
  resourceSettlementRef(...parts);

const unsettledPreResourceClaim = makePreClaim({
  operationRef: "resource:unsettled-pre:mutate",
  scopeRef: { kind: "external", scopeId: "resource/account/acme/main", systemRef: "resource" },
  authorityRef: RESOURCE_AUTHORITIES.MUTATE,
  originRef: {
    originId: "@agent-os/resource-carrier",
    originKind: "extension_package",
  },
});

describe("@agent-os/resource-carrier", () => {
  it("declares resource.* as an extension-owned prefix", () => {
    expect(resourceBoundaryPackage("0.1.0")).toMatchObject({
      packageId: "@agent-os/resource-carrier",
      kindPrefixes: ["resource."],
      version: "0.1.0",
    });
  });

  it("declares required material contracts without concrete refs", () => {
    expect(resourceAuthorityContracts).toEqual([
      {
        authorityRef: RESOURCE_AUTHORITIES.PROVISION,
        requiredMaterials: [
          {
            slot: "api_token",
            kind: "credential",
            purpose: "resource_api",
            required: true,
          },
          {
            slot: "account",
            kind: "external_resource",
            resourceKind: "account",
            required: true,
          },
        ],
      },
      {
        authorityRef: RESOURCE_AUTHORITIES.BIND,
        requiredMaterials: expect.arrayContaining([
          expect.objectContaining({ slot: "binding", kind: "binding", required: true }),
        ]),
      },
      {
        authorityRef: RESOURCE_AUTHORITIES.MUTATE,
        requiredMaterials: expect.arrayContaining([
          expect.objectContaining({ slot: "binding", kind: "binding", required: true }),
        ]),
      },
      {
        authorityRef: RESOURCE_AUTHORITIES.DESTROY,
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
        kind: RESOURCE_KIND.RESOURCE_PROVISIONED,
        payload: {
          subjectRef: "res-1",
          resourceKind: "database",
          resourceRef: resourceRef,
          accountRef,
          proofRef: resourceProofRef("database", "provision"),
          claim: livedResourceClaim("provision", resourceProofRef("database", "provision")),
        },
      },
      {
        id: 2,
        kind: RESOURCE_KIND.RESOURCE_BOUND,
        payload: {
          subjectRef: "res-1",
          resourceRef: resourceRef,
          bindingRef: resourceBindingRef,
          proofRef: resourceProofRef("database", "bind"),
          claim: livedResourceClaim("bind", resourceProofRef("database", "bind")),
        },
      },
      {
        id: 3,
        kind: RESOURCE_KIND.MUTATION_RECORDED,
        payload: {
          subjectRef: "res-1",
          resourceRef: resourceBindingRef,
          mutationKind: "database.exec",
          mutationRef: "mutation://database/001",
          proofRef: resourceProofRef("database", "exec", "001"),
          fingerprint: "sha256:abc",
          claim: livedResourceClaim("mutate", resourceProofRef("database", "exec", "001")),
        },
      },
      {
        id: 4,
        kind: RESOURCE_KIND.MUTATION_RECORDED,
        payload: {
          subjectRef: "res-1",
          resourceRef: resourceBindingRef,
          mutationKind: "database.exec",
          mutationRef: "mutation://database/002",
          proofRef: resourceProofRef("database", "exec", "002"),
          fingerprint: "sha256:def",
          claim: livedResourceClaim("mutate", resourceProofRef("database", "exec", "002")),
        },
      },
    ] as const;

    expect(projectResource(events, "res-1")).toEqual({
      subjectRef: "res-1",
      status: "mutated",
      lastEventKind: RESOURCE_KIND.MUTATION_RECORDED,
      resourceKind: "database",
      resourceRef: resourceBindingRef,
      accountRef,
      bindingRef: resourceBindingRef,
      latestMutation: {
        eventId: 4,
        subjectRef: "res-1",
        resourceRef: resourceBindingRef,
        mutationKind: "database.exec",
        mutationRef: "mutation://database/002",
        proofRef: resourceProofRef("database", "exec", "002"),
        fingerprint: "sha256:def",
        claim: livedResourceClaim("mutate", resourceProofRef("database", "exec", "002")),
      },
      mutationEventIds: [3, 4],
      failure: undefined,
    });
  });

  it("ignores resolved material and raw bytes because payloads require symbolic refs", () => {
    const events = [
      {
        id: 1,
        kind: RESOURCE_KIND.MUTATION_RECORDED,
        payload: {
          subjectRef: "res-raw",
          resourceRef: { rawBinding: {} },
          mutationKind: "r2.put",
          mutationRef: "mutation://r2/put",
          proofRef: resourceProofRef("r2", "put"),
          rawBytes: new Uint8Array([1, 2, 3]),
        },
      },
    ] as const;

    expect(projectResource(events, "res-raw")).toEqual({
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

  it("settles resource.* failure facts through ExtensionCapability", async () => {
    const committed: Array<{ event: string; data: unknown }> = [];
    const cap: ExtensionCapability = {
      packageId: "@agent-os/resource-carrier",
      kindPrefixes: ["resource."],
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
      makeCommitters(RESOURCE_EVENTS, cap)[RESOURCE_KIND.FAILED]({
        subjectRef: "res-1",
        step: "mutate",
        proofRef: rejectedResourceProofRef,
        reason: "resource rejected statement",
        claim: rejectedResourceClaim,
      }),
    ).resolves.toEqual({ id: 1 });

    expect(committed).toEqual([
      {
        event: RESOURCE_KIND.FAILED,
        data: {
          subjectRef: "res-1",
          step: "mutate",
          proofRef: rejectedResourceProofRef,
          reason: "resource rejected statement",
          claim: {
            phase: "rejected",
            operationRef: "resource:subject-1:mutate",
            scopeRef: {
              kind: "external",
              scopeId: "resource/account/acme/main",
              systemRef: "resource",
            },
            authorityRef: RESOURCE_AUTHORITIES.MUTATE,
            originRef: {
              originId: "@agent-os/resource-carrier",
              originKind: "extension_package",
            },
            rejectionRef: {
              rejectionId: rejectedResourceProofRef,
              rejectionKind: "provider_rejected",
              reason: "resource_rejected_statement",
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
        kind: RESOURCE_KIND.MUTATION_RECORDED,
        payload: {
          subjectRef: "res-unsettled",
          resourceRef: resourceBindingRef,
          mutationKind: "database.exec",
          mutationRef: "mutation://database/unsettled",
          proofRef: resourceProofRef("database", "unsettled"),
        },
      },
      {
        id: 2,
        kind: RESOURCE_KIND.MUTATION_RECORDED,
        payload: {
          subjectRef: "res-unsettled",
          resourceRef: resourceBindingRef,
          mutationKind: "database.exec",
          mutationRef: "mutation://database/preclaim",
          proofRef: resourceProofRef("database", "preclaim"),
          claim: unsettledPreResourceClaim,
        },
      },
    ] as const;

    expect(projectResource(events, "res-unsettled")).toEqual({
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

  it("does not project lifecycle state from bound, mutation, or destroyed events without provision", () => {
    const baseExpected = {
      subjectRef: "res-lone",
      status: "missing",
      lastEventKind: undefined,
      resourceKind: undefined,
      resourceRef: undefined,
      accountRef: undefined,
      bindingRef: undefined,
      latestMutation: undefined,
      mutationEventIds: [],
      failure: undefined,
    };

    expect(
      projectResource(
        [
          {
            id: 1,
            kind: RESOURCE_KIND.RESOURCE_BOUND,
            payload: {
              subjectRef: "res-lone",
              resourceRef: resourceRef,
              bindingRef: resourceBindingRef,
              proofRef: resourceProofRef("database", "bind"),
              claim: livedResourceClaim("bind", resourceProofRef("database", "bind")),
            },
          },
        ],
        "res-lone",
      ),
    ).toEqual(baseExpected);

    expect(
      projectResource(
        [
          {
            id: 1,
            kind: RESOURCE_KIND.MUTATION_RECORDED,
            payload: {
              subjectRef: "res-lone",
              resourceRef: resourceBindingRef,
              mutationKind: "database.exec",
              mutationRef: "mutation://database/lone",
              proofRef: resourceProofRef("database", "lone"),
              claim: livedResourceClaim("mutate", resourceProofRef("database", "lone")),
            },
          },
        ],
        "res-lone",
      ),
    ).toEqual(baseExpected);

    expect(
      projectResource(
        [
          {
            id: 1,
            kind: RESOURCE_KIND.RESOURCE_DESTROYED,
            payload: {
              subjectRef: "res-lone",
              resourceRef: resourceRef,
              proofRef: resourceProofRef("database", "destroy"),
              reason: "manual",
              claim: livedResourceClaim("destroy", resourceProofRef("database", "destroy")),
            },
          },
        ],
        "res-lone",
      ),
    ).toEqual(baseExpected);
  });
});
