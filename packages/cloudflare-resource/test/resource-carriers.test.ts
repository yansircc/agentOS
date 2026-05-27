import { Cause, Effect, Exit, Option } from "effect";
import { describe, expect, it, vi } from "@effect/vitest";
import { makePreClaim } from "@agent-os/core/effect-claim";
import {
  bindingMaterialRef,
  credentialMaterialRef,
  externalResourceMaterialRef,
  materialRefKey,
  type MaterialRef,
} from "@agent-os/core/material-ref";
import type { RefResolver } from "@agent-os/core/ref-resolver";

import {
  CLOUDFLARE_RESOURCE_AUTHORITIES,
  makeCloudflareD1ResourceCarrier,
  makeCloudflareKVNamespaceResourceCarrier,
  makeCloudflareQueueResourceCarrier,
  makeCloudflareR2BucketResourceCarrier,
  makeCloudflareWorkflowResourceCarrier,
  type CloudflareD1Fetch,
  type CloudflareD1MutationInput,
  type CloudflareKVNamespaceMutationInput,
  type CloudflareQueueMutationInput,
  type CloudflareR2BucketMutationInput,
  type CloudflareResourceCarrier,
  type CloudflareWorkflowMutationInput,
} from "../src";

const expectFailure = <A>(exit: Exit.Exit<unknown, A>): A => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    const failure = Cause.failureOption(exit.cause);
    expect(Option.isSome(failure)).toBe(true);
    if (Option.isSome(failure)) {
      return failure.value;
    }
  }
  expect.fail("expected failed exit");
  return undefined as never;
};

const credentialRef = credentialMaterialRef("tenant/cloudflare/api-token", {
  provider: "cloudflare",
  purpose: "cloudflare_api",
});

const accountRef = externalResourceMaterialRef({
  provider: "cloudflare",
  resourceKind: "account",
  ref: "tenant/account/main",
});

interface ResourceCase {
  readonly resourceKind: "d1" | "kv_namespace" | "r2_bucket" | "queue" | "workflow";
  readonly bindingKind: string;
  readonly mutationKind: string;
  readonly resourceMaterial: unknown;
  readonly rawMaterialNeedle: string;
  readonly mutationInput: unknown;
  readonly inputNeedle: string;
  readonly makeCarrier: (options: TestCarrierOptions) => CloudflareResourceCarrier;
}

interface TestCarrierOptions {
  readonly fetch: CloudflareD1Fetch;
  readonly resolver: RefResolver;
  readonly resolveMutationInput: (inputRef: string) => Promise<unknown | null>;
  readonly carrierRef?: string;
}

const cases: ReadonlyArray<ResourceCase> = [
  {
    resourceKind: "d1",
    bindingKind: "d1",
    mutationKind: "d1.exec",
    resourceMaterial: { databaseId: "raw-db-id" },
    rawMaterialNeedle: "raw-db-id",
    mutationInput: { sql: "select raw_sql_secret" },
    inputNeedle: "raw_sql_secret",
    makeCarrier: (options) =>
      makeCloudflareD1ResourceCarrier({
        ...options,
        resolveMutationInput: (inputRef) =>
          options.resolveMutationInput(inputRef) as Promise<CloudflareD1MutationInput | null>,
      }),
  },
  {
    resourceKind: "kv_namespace",
    bindingKind: "kv_namespace",
    mutationKind: "kv_namespace.bulk_put",
    resourceMaterial: { namespaceId: "raw-kv-namespace-id" },
    rawMaterialNeedle: "raw-kv-namespace-id",
    mutationInput: { body: [{ key: "private-key", value: "raw_kv_value_secret" }] },
    inputNeedle: "raw_kv_value_secret",
    makeCarrier: (options) =>
      makeCloudflareKVNamespaceResourceCarrier({
        ...options,
        resolveMutationInput: (inputRef) =>
          options.resolveMutationInput(inputRef) as Promise<CloudflareKVNamespaceMutationInput | null>,
      }),
  },
  {
    resourceKind: "r2_bucket",
    bindingKind: "r2_bucket",
    mutationKind: "r2_bucket.put_object",
    resourceMaterial: { bucketName: "raw-r2-bucket-name" },
    rawMaterialNeedle: "raw-r2-bucket-name",
    mutationInput: { objectKey: "private-object", body: "raw_r2_object_secret" },
    inputNeedle: "raw_r2_object_secret",
    makeCarrier: (options) =>
      makeCloudflareR2BucketResourceCarrier({
        ...options,
        resolveMutationInput: (inputRef) =>
          options.resolveMutationInput(inputRef) as Promise<CloudflareR2BucketMutationInput | null>,
      }),
  },
  {
    resourceKind: "queue",
    bindingKind: "queue",
    mutationKind: "queue.send",
    resourceMaterial: { queueId: "raw-queue-id" },
    rawMaterialNeedle: "raw-queue-id",
    mutationInput: { body: { secret: "raw_queue_message_secret" } },
    inputNeedle: "raw_queue_message_secret",
    makeCarrier: (options) =>
      makeCloudflareQueueResourceCarrier({
        ...options,
        resolveMutationInput: (inputRef) =>
          options.resolveMutationInput(inputRef) as Promise<CloudflareQueueMutationInput | null>,
      }),
  },
  {
    resourceKind: "workflow",
    bindingKind: "workflow",
    mutationKind: "workflow.create_instance",
    resourceMaterial: {
      workflowName: "raw-workflow-name",
      className: "WorkflowEntrypoint",
      scriptName: "worker-script",
    },
    rawMaterialNeedle: "raw-workflow-name",
    mutationInput: { instanceId: "private-instance", payload: { secret: "raw_workflow_payload" } },
    inputNeedle: "raw_workflow_payload",
    makeCarrier: (options) =>
      makeCloudflareWorkflowResourceCarrier({
        ...options,
        resolveMutationInput: (inputRef) =>
          options.resolveMutationInput(inputRef) as Promise<CloudflareWorkflowMutationInput | null>,
      }),
  },
];

const claimFor = (resourceKind: ResourceCase["resourceKind"], step: string) =>
  makePreClaim({
    operationRef: `cf-resource:${resourceKind}:subject:${step}`,
    scopeRef: {
      kind: "external",
      scopeId: `cloudflare/tenant/${resourceKind}/main`,
      systemRef: "cloudflare",
    },
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

const refsFor = (testCase: ResourceCase) => ({
  resourceRef: externalResourceMaterialRef({
    provider: "cloudflare",
    resourceKind: testCase.resourceKind,
    ref: `tenant/${testCase.resourceKind}/main`,
  }),
  bindingRef: bindingMaterialRef({
    provider: "cloudflare",
    bindingKind: testCase.bindingKind,
    ref: `BINDING_${testCase.resourceKind.toUpperCase()}`,
  }),
});

const resolverFor = (entries: ReadonlyArray<readonly [MaterialRef, unknown]>): RefResolver => {
  const materials = new Map(entries.map(([ref, value]) => [materialRefKey(ref), value]));
  return {
    material: (ref) => materials.get(materialRefKey(ref)) ?? null,
  };
};

const successResponse = {
  ok: true,
  status: 200,
  json: async () => ({ success: true, result: {} }),
};

const assertNegativeContract = (testCase: ResourceCase) => {
  describe(testCase.resourceKind, () => {
    it.effect("fast-fails unsupported mutation before material resolution or fetch", () =>
      Effect.gen(function* () {
      let resolved = false;
      const fetch = vi.fn<CloudflareD1Fetch>();
      const { resourceRef, bindingRef } = refsFor(testCase);
      const carrier = testCase.makeCarrier({
        fetch,
        resolver: {
          material: () => {
            resolved = true;
            return "should-not-resolve";
          },
        },
        resolveMutationInput: async () => null,
      });

      const failure = expectFailure(
        yield* Effect.exit(
          carrier.mutate({
            claim: claimFor(testCase.resourceKind, "mutate"),
            subjectRef: `subject-${testCase.resourceKind}`,
            credentialRef,
            accountRef,
            resourceRef,
            bindingRef,
            mutationKind: `${testCase.resourceKind}.unsupported`,
            inputRef: "mutation://unsupported",
          }),
        ),
      );

      expect(resolved).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
      expect(failure).toMatchObject({
        code: "UnsupportedResource",
        step: "mutate",
        claim: {
          phase: "rejected",
          rejectionRef: {
            rejectionKind: "unsupported",
          },
        },
      });
      }),
    );

    it.effect("fast-fails missing resolved resource material before provider fetch", () =>
      Effect.gen(function* () {
      const fetch = vi.fn<CloudflareD1Fetch>();
      const { resourceRef, bindingRef } = refsFor(testCase);
      const carrier = testCase.makeCarrier({
        fetch,
        resolver: resolverFor([
          [credentialRef, "secret-token"],
          [accountRef, { accountId: "raw-account-id" }],
          [bindingRef, { bindingName: "BINDING" }],
        ]),
        resolveMutationInput: async () => testCase.mutationInput,
      });

      const failure = expectFailure(
        yield* Effect.exit(
          carrier.mutate({
            claim: claimFor(testCase.resourceKind, "mutate"),
            subjectRef: `subject-${testCase.resourceKind}`,
            credentialRef,
            accountRef,
            resourceRef,
            bindingRef,
            mutationKind: testCase.mutationKind,
            inputRef: "mutation://input",
          }),
        ),
      );

      expect(fetch).not.toHaveBeenCalled();
      expect(failure).toMatchObject({
        code: "MaterialUnavailable",
        step: "mutate",
      });
      }),
    );

    it.effect("redacts resolved material, provider body, and data-plane input from failures", () =>
      Effect.gen(function* () {
      const { resourceRef, bindingRef } = refsFor(testCase);
      const fetch: CloudflareD1Fetch = async () => ({
        ok: false,
        status: 500,
        json: async () => ({
          success: false,
          errors: [{ message: "raw_provider_body_secret" }],
        }),
      });
      const carrier = testCase.makeCarrier({
        fetch,
        resolver: resolverFor([
          [credentialRef, "secret-token"],
          [accountRef, { accountId: "raw-account-id" }],
          [resourceRef, testCase.resourceMaterial],
          [bindingRef, { bindingName: "RAW_BINDING" }],
        ]),
        resolveMutationInput: async () => testCase.mutationInput,
      });

      const failure = expectFailure(
        yield* Effect.exit(
          carrier.mutate({
            claim: claimFor(testCase.resourceKind, "mutate"),
            subjectRef: `subject-${testCase.resourceKind}`,
            credentialRef,
            accountRef,
            resourceRef,
            bindingRef,
            mutationKind: testCase.mutationKind,
            inputRef: "mutation://input",
          }),
        ),
      );

      const serialized = JSON.stringify(failure);
      expect(serialized).not.toContain("secret-token");
      expect(serialized).not.toContain("raw-account-id");
      expect(serialized).not.toContain("RAW_BINDING");
      expect(serialized).not.toContain(testCase.rawMaterialNeedle);
      expect(serialized).not.toContain(testCase.inputNeedle);
      expect(serialized).not.toContain("raw_provider_body_secret");
      expect(failure.proofRef).not.toContain("raw-account-id");
      expect(failure.proofRef).not.toContain(testCase.rawMaterialNeedle);
      expect(failure).toMatchObject({
        code: "MutationFailed",
        step: "mutate",
      });
      }),
    );

    it.effect("uses symbolic mutation records after executing with resolved material", () =>
      Effect.gen(function* () {
      const { resourceRef, bindingRef } = refsFor(testCase);
      const carrier = testCase.makeCarrier({
        fetch: async () => successResponse,
        resolver: resolverFor([
          [credentialRef, "secret-token"],
          [accountRef, { accountId: "raw-account-id" }],
          [resourceRef, testCase.resourceMaterial],
          [bindingRef, { bindingName: "RAW_BINDING" }],
        ]),
        resolveMutationInput: async () => testCase.mutationInput,
        carrierRef: `carrier-${testCase.resourceKind}`,
      });

      const mutation = yield* carrier.mutate({
          claim: claimFor(testCase.resourceKind, "mutate"),
          subjectRef: `subject-${testCase.resourceKind}`,
          credentialRef,
          accountRef,
          resourceRef,
          bindingRef,
          mutationKind: testCase.mutationKind,
          inputRef: "mutation://input",
          fingerprint: `sha256:${testCase.resourceKind}`,
        });

      const serialized = JSON.stringify(mutation);
      expect(mutation).toMatchObject({
        subjectRef: `subject-${testCase.resourceKind}`,
        resourceRef,
        mutationKind: testCase.mutationKind,
        mutationRef: "mutation://input",
        fingerprint: `sha256:${testCase.resourceKind}`,
        claim: {
          phase: "lived",
          anchorRef: {
            carrierRef: `carrier-${testCase.resourceKind}`,
          },
        },
      });
      expect(serialized).not.toContain("secret-token");
      expect(serialized).not.toContain("raw-account-id");
      expect(serialized).not.toContain("RAW_BINDING");
      expect(serialized).not.toContain(testCase.rawMaterialNeedle);
      expect(serialized).not.toContain(testCase.inputNeedle);
      }),
    );
  });
};

describe("@agent-os/cloudflare-resource core5 negative contract", () => {
  for (const testCase of cases) {
    assertNegativeContract(testCase);
  }
});
