#!/usr/bin/env bun

import { Effect } from "effect";
import { makePreClaim } from "@agent-os/core/effect-claim";
import {
  bindingMaterialRef,
  credentialMaterialRef,
  externalResourceMaterialRef,
  materialRefKey,
} from "@agent-os/core/material-ref";
import {
  CLOUDFLARE_RESOURCE_AUTHORITIES,
  makeCloudflareD1ResourceCarrier,
  makeCloudflareKVNamespaceResourceCarrier,
  makeCloudflareQueueResourceCarrier,
  makeCloudflareR2BucketResourceCarrier,
  projectCloudflareResource,
} from "../src/index.ts";

const requiredEnv = (name) => {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`missing required env ${name}`);
  }
  return value;
};

const safeName = (value, maxLength = 48) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength);

const upperBindingName = (value) => safeName(value).replaceAll("-", "_").toUpperCase();

const accountId = requiredEnv("CLOUDFLARE_ACCOUNT_ID");
const apiToken = requiredEnv("CLOUDFLARE_API_TOKEN");
const testRunId = requiredEnv("TEST_RUN_ID");
const scopePrefix = requiredEnv("SCOPE_PREFIX");
const namePrefix = safeName(scopePrefix, 32);

const credentialRef = credentialMaterialRef("cloudflare-api-token", {
  provider: "cloudflare",
  purpose: "cloudflare_api",
});

const accountRef = externalResourceMaterialRef({
  provider: "cloudflare",
  resourceKind: "account",
  ref: `live/${testRunId}/account`,
});

const baseMaterials = new Map([
  [materialRefKey(credentialRef), apiToken],
  [materialRefKey(accountRef), { accountId }],
]);

const resourceCases = [
  {
    resourceKind: "d1",
    bindingKind: "d1",
    resourceName: safeName(`${namePrefix}-d1-${Date.now().toString(36)}`),
    mutationKind: "d1.exec",
    mutationInput: {
      sql: "CREATE TABLE agentos_core_smoke (id INTEGER PRIMARY KEY, label TEXT NOT NULL)",
    },
    dataNeedle: "CREATE TABLE",
    materialNeedle: (material) => material.databaseId,
    makeCarrier: makeCloudflareD1ResourceCarrier,
  },
  {
    resourceKind: "kv_namespace",
    bindingKind: "kv_namespace",
    resourceName: safeName(`${namePrefix}-kv-${Date.now().toString(36)}`),
    mutationKind: "kv_namespace.bulk_put",
    mutationInput: {
      body: [{ key: "agentos-core-smoke", value: `raw-kv-value-${testRunId}` }],
    },
    dataNeedle: `raw-kv-value-${testRunId}`,
    materialNeedle: (material) => material.namespaceId,
    makeCarrier: makeCloudflareKVNamespaceResourceCarrier,
  },
  {
    resourceKind: "r2_bucket",
    bindingKind: "r2_bucket",
    resourceName: safeName(`${namePrefix}-r2-${Date.now().toString(36)}`, 54),
    mutationKind: "r2_bucket.put_object",
    mutationInput: {
      objectKey: `agentos-core-smoke-${testRunId}.txt`,
      body: `raw-r2-object-${testRunId}`,
      contentType: "text/plain",
    },
    cleanupMutation: {
      mutationKind: "r2_bucket.delete_object",
      mutationInput: {
        objectKey: `agentos-core-smoke-${testRunId}.txt`,
      },
    },
    dataNeedle: `raw-r2-object-${testRunId}`,
    materialNeedle: () => null,
    makeCarrier: makeCloudflareR2BucketResourceCarrier,
  },
  {
    resourceKind: "queue",
    bindingKind: "queue",
    resourceName: safeName(`${namePrefix}-queue-${Date.now().toString(36)}`),
    mutationKind: "queue.send",
    mutationInput: {
      body: `raw-queue-message-${testRunId}`,
    },
    dataNeedle: `raw-queue-message-${testRunId}`,
    materialNeedle: (material) => material.queueId,
    makeCarrier: makeCloudflareQueueResourceCarrier,
  },
];

const assertPrefixed = (resourceName) => {
  if (!resourceName.startsWith(namePrefix)) {
    throw new Error("live resource name must be prefixed by SCOPE_PREFIX");
  }
};

const claimFor = (resourceKind, resourceName, step) =>
  makePreClaim({
    operationRef: `cf-core-live-smoke:${testRunId}:${resourceKind}:${step}:${resourceName}`,
    scopeRef: {
      kind: "external",
      scopeId: `cloudflare/${testRunId}/${resourceKind}/${resourceName}`,
      systemRef: "cloudflare",
    },
    authorityRef:
      step === "provision"
        ? CLOUDFLARE_RESOURCE_AUTHORITIES.PROVISION
        : step === "bind"
          ? CLOUDFLARE_RESOURCE_AUTHORITIES.BIND
          : step === "mutate"
            ? CLOUDFLARE_RESOURCE_AUTHORITIES.MUTATE
            : CLOUDFLARE_RESOURCE_AUTHORITIES.DESTROY,
    originRef: {
      originId: "@agent-os/cloudflare-resource.core-live-smoke",
      originKind: "test",
    },
  });

const redactionScan = (label, value, needles) => {
  const serialized = JSON.stringify(value);
  for (const needle of needles) {
    if (typeof needle === "string" && needle.length > 0 && serialized.includes(needle)) {
      throw new Error(`${label} leaked resolved material`);
    }
  }
};

const runResource = async (testCase) => {
  assertPrefixed(testCase.resourceName);

  const resourceRef = externalResourceMaterialRef({
    provider: "cloudflare",
    resourceKind: testCase.resourceKind,
    ref: `live/${testRunId}/${testCase.resourceKind}/${testCase.resourceName}`,
  });
  const bindingRef = bindingMaterialRef({
    provider: "cloudflare",
    bindingKind: testCase.bindingKind,
    ref: `${upperBindingName(namePrefix)}_${upperBindingName(testCase.resourceKind)}_SMOKE`,
  });
  const mutationRef = `mutation://${testCase.resourceKind}/${testCase.resourceName}/write`;
  const cleanupMutationRef = `mutation://${testCase.resourceKind}/${testCase.resourceName}/cleanup`;
  const materials = new Map(baseMaterials);
  materials.set(materialRefKey(bindingRef), { bindingName: bindingRef.ref });
  const mutationInputs = new Map([[mutationRef, testCase.mutationInput]]);
  if (testCase.cleanupMutation !== undefined) {
    mutationInputs.set(cleanupMutationRef, testCase.cleanupMutation.mutationInput);
  }
  const events = [];
  let provisionedRef = resourceRef;
  let destroyed = false;
  let cleanupRequired = false;

  const carrier = testCase.makeCarrier({
    fetch,
    resolver: {
      material: (ref) => materials.get(materialRefKey(ref)) ?? null,
    },
    resolveMutationInput: async (inputRef) => mutationInputs.get(inputRef) ?? null,
    recordMaterial: (ref, material) => {
      materials.set(materialRefKey(ref), material);
    },
    carrierRef: `cloudflare-${testCase.resourceKind}-live-smoke`,
  });

  const event = (kind, payload) => {
    const row = { id: events.length + 1, kind, payload };
    events.push(row);
    return row;
  };

  try {
    const provisioned = await Effect.runPromise(
      carrier.provision({
        claim: claimFor(testCase.resourceKind, testCase.resourceName, "provision"),
        subjectRef: testCase.resourceName,
        resourceKind: testCase.resourceKind,
        resourceName: testCase.resourceName,
        credentialRef,
        accountRef,
        resourceRef,
        bindingRef,
      }),
    );
    provisionedRef = provisioned.resourceRef;
    event("cf_resource.resource.provisioned", provisioned);

    const bound = await Effect.runPromise(
      carrier.bind({
        claim: claimFor(testCase.resourceKind, testCase.resourceName, "bind"),
        subjectRef: testCase.resourceName,
        credentialRef,
        accountRef,
        resourceRef: provisionedRef,
        bindingRef,
      }),
    );
    event("cf_resource.resource.bound", bound);

    const mutated = await Effect.runPromise(
      carrier.mutate({
        claim: claimFor(testCase.resourceKind, testCase.resourceName, "mutate"),
        subjectRef: testCase.resourceName,
        credentialRef,
        accountRef,
        resourceRef: provisionedRef,
        bindingRef,
        mutationKind: testCase.mutationKind,
        inputRef: mutationRef,
        fingerprint: `sha256:${testCase.resourceKind}:${testRunId}`,
      }),
    );
    event("cf_resource.mutation.recorded", mutated);
    cleanupRequired = testCase.cleanupMutation !== undefined;

    if (testCase.cleanupMutation !== undefined) {
      const cleaned = await Effect.runPromise(
        carrier.mutate({
          claim: claimFor(testCase.resourceKind, testCase.resourceName, "mutate"),
          subjectRef: testCase.resourceName,
          credentialRef,
          accountRef,
          resourceRef: provisionedRef,
          bindingRef,
          mutationKind: testCase.cleanupMutation.mutationKind,
          inputRef: cleanupMutationRef,
          fingerprint: `sha256:${testCase.resourceKind}:${testRunId}:cleanup`,
        }),
      );
      event("cf_resource.mutation.recorded", cleaned);
      cleanupRequired = false;
    }

    const destroyedPayload = await Effect.runPromise(
      carrier.destroy({
        claim: claimFor(testCase.resourceKind, testCase.resourceName, "destroy"),
        subjectRef: testCase.resourceName,
        credentialRef,
        accountRef,
        resourceRef: provisionedRef,
        reason: "manual",
      }),
    );
    destroyed = true;
    event("cf_resource.resource.destroyed", destroyedPayload);

    const projection = projectCloudflareResource(events, testCase.resourceName);
    if (projection.status !== "destroyed") {
      throw new Error(`expected destroyed projection, got ${projection.status}`);
    }
    const resourceMaterial = materials.get(materialRefKey(provisionedRef));
    redactionScan(`${testCase.resourceKind} events`, events, [
      apiToken,
      accountId,
      testCase.dataNeedle,
      testCase.materialNeedle(resourceMaterial ?? {}),
    ]);
    redactionScan(`${testCase.resourceKind} projection`, projection, [
      apiToken,
      accountId,
      testCase.dataNeedle,
      testCase.materialNeedle(resourceMaterial ?? {}),
    ]);

    return {
      resourceKind: testCase.resourceKind,
      subjectRef: testCase.resourceName,
      finalStatus: projection.status,
      eventCount: events.length,
    };
  } finally {
    if (!destroyed && materials.has(materialRefKey(provisionedRef))) {
      if (cleanupRequired && testCase.cleanupMutation !== undefined) {
        await Effect.runPromise(
          carrier.mutate({
            claim: claimFor(testCase.resourceKind, testCase.resourceName, "mutate"),
            subjectRef: testCase.resourceName,
            credentialRef,
            accountRef,
            resourceRef: provisionedRef,
            bindingRef,
            mutationKind: testCase.cleanupMutation.mutationKind,
            inputRef: cleanupMutationRef,
            fingerprint: `sha256:${testCase.resourceKind}:${testRunId}:cleanup`,
          }),
        );
      }
      await Effect.runPromise(
        carrier.destroy({
          claim: claimFor(testCase.resourceKind, testCase.resourceName, "destroy"),
          subjectRef: testCase.resourceName,
          credentialRef,
          accountRef,
          resourceRef: provisionedRef,
          reason: "cleanup",
        }),
      );
    }
  }
};

const results = [];
for (const testCase of resourceCases) {
  results.push(await runResource(testCase));
}

console.log(
  JSON.stringify(
    {
      ok: true,
      testRunId,
      resources: results,
    },
    null,
    2,
  ),
);
