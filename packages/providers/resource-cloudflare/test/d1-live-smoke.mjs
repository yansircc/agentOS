#!/usr/bin/env bun

import { Effect } from "effect";
import { makePreClaim } from "@agent-os/core/effect-claim";
import {
  bindingMaterialRef,
  credentialMaterialRef,
  externalResourceMaterialRef,
  materialRefKey,
} from "@agent-os/core/material-ref";
import { makeCloudflareD1ResourceCarrier } from "../src/index.ts";
import { RESOURCE_AUTHORITIES, projectResource } from "@agent-os/resource-carrier";

const requiredEnv = (name) => {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`missing required env ${name}`);
  }
  return value;
};

const safeName = (value) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

const accountId = requiredEnv("CLOUDFLARE_ACCOUNT_ID");
const apiToken = requiredEnv("CLOUDFLARE_API_TOKEN");
const testRunId = requiredEnv("TEST_RUN_ID");
const scopePrefix = requiredEnv("SCOPE_PREFIX");
const resourceName = safeName(`${scopePrefix}-d1-live-smoke-${Date.now().toString(36)}`);

if (!resourceName.startsWith(safeName(scopePrefix))) {
  throw new Error("live D1 resource name must be prefixed by SCOPE_PREFIX");
}

const credentialRef = credentialMaterialRef("cloudflare-api-token", {
  provider: "cloudflare",
  purpose: "cloudflare_api",
});

const accountRef = externalResourceMaterialRef({
  provider: "cloudflare",
  resourceKind: "account",
  ref: `live/${testRunId}/account`,
});

const resourceRef = externalResourceMaterialRef({
  provider: "cloudflare",
  resourceKind: "d1",
  ref: `live/${testRunId}/d1/${resourceName}`,
});

const bindingRef = bindingMaterialRef({
  provider: "cloudflare",
  bindingKind: "d1",
  ref: `${safeName(scopePrefix).replaceAll("-", "_").toUpperCase()}_D1_SMOKE`,
});

const materials = new Map([
  [materialRefKey(credentialRef), apiToken],
  [materialRefKey(accountRef), { accountId }],
  [materialRefKey(bindingRef), { bindingName: bindingRef.ref }],
]);

const resolver = {
  material: (ref) => {
    return materials.get(materialRefKey(ref)) ?? null;
  },
};

const mutationInputs = new Map([
  [
    `mutation://${resourceName}/create-table`,
    {
      sql: "CREATE TABLE agentos_live_smoke (id INTEGER PRIMARY KEY, label TEXT NOT NULL)",
    },
  ],
]);

const carrier = makeCloudflareD1ResourceCarrier({
  fetch,
  resolver,
  resolveMutationInput: async (inputRef) => mutationInputs.get(inputRef) ?? null,
  recordMaterial: (ref, material) => {
    materials.set(materialRefKey(ref), material);
  },
  carrierRef: "cloudflare-d1-live-smoke",
});

const claimFor = (step) =>
  makePreClaim({
    operationRef: `cf-d1-live-smoke:${testRunId}:${step}:${resourceName}`,
    scopeRef: {
      kind: "external",
      scopeId: `cloudflare/${testRunId}/d1/${resourceName}`,
      systemRef: "cloudflare",
    },
    effectAuthorityRef:
      step === "provision"
        ? RESOURCE_AUTHORITIES.PROVISION
        : step === "bind"
          ? RESOURCE_AUTHORITIES.BIND
          : step === "mutate"
            ? RESOURCE_AUTHORITIES.MUTATE
            : RESOURCE_AUTHORITIES.DESTROY,
    originRef: {
      originId: "@agent-os/resource-cloudflare.d1-live-smoke",
      originKind: "test",
    },
  });

const redactionScan = (label, value) => {
  const serialized = JSON.stringify(value);
  if (serialized.includes(apiToken)) {
    throw new Error(`${label} leaked resolved credential material`);
  }
  if (serialized.includes(accountId)) {
    throw new Error(`${label} leaked resolved account material`);
  }
  if (serialized.includes("CREATE TABLE")) {
    throw new Error(`${label} leaked resolved mutation SQL`);
  }
  const databaseMaterial = materials.get(materialRefKey(resourceRef));
  if (
    databaseMaterial &&
    typeof databaseMaterial.databaseId === "string" &&
    serialized.includes(databaseMaterial.databaseId)
  ) {
    throw new Error(`${label} leaked resolved D1 database material`);
  }
};

const run = async () => {
  let provisionedResourceRef;
  const events = [];

  try {
    const provisioned = await Effect.runPromise(
      carrier.provision({
        claim: claimFor("provision"),
        subjectRef: resourceName,
        resourceKind: "d1",
        resourceName,
        credentialRef,
        accountRef,
        resourceRef,
        bindingRef,
      }),
    );
    provisionedResourceRef = provisioned.resourceRef;
    events.push({
      id: events.length + 1,
      kind: "resource.provisioned",
      payload: provisioned,
    });

    const bound = await Effect.runPromise(
      carrier.bind({
        claim: claimFor("bind"),
        subjectRef: resourceName,
        credentialRef,
        accountRef,
        resourceRef: provisionedResourceRef,
        bindingRef,
      }),
    );
    events.push({ id: events.length + 1, kind: "resource.bound", payload: bound });

    const mutationRef = `mutation://${resourceName}/create-table`;
    const mutated = await Effect.runPromise(
      carrier.mutate({
        claim: claimFor("mutate"),
        subjectRef: resourceName,
        credentialRef,
        accountRef,
        resourceRef: provisionedResourceRef,
        bindingRef,
        mutationKind: "d1.exec",
        inputRef: mutationRef,
        fingerprint: `sha256:${resourceName}`,
      }),
    );
    events.push({
      id: events.length + 1,
      kind: "resource.mutation.recorded",
      payload: mutated,
    });

    const destroyed = await Effect.runPromise(
      carrier.destroy({
        claim: claimFor("destroy"),
        subjectRef: resourceName,
        credentialRef,
        accountRef,
        resourceRef: provisionedResourceRef,
        reason: "manual",
      }),
    );
    events.push({
      id: events.length + 1,
      kind: "resource.destroyed",
      payload: destroyed,
    });

    const projection = projectResource(events, resourceName);
    if (projection.status !== "destroyed") {
      throw new Error(`expected destroyed projection, got ${projection.status}`);
    }
    redactionScan("live D1 events", events);
    redactionScan("live D1 projection", projection);

    console.log(
      JSON.stringify(
        {
          ok: true,
          testRunId,
          subjectRef: resourceName,
          resourceKind: "d1",
          finalStatus: projection.status,
          eventCount: events.length,
        },
        null,
        2,
      ),
    );
  } catch (cause) {
    const databaseMaterial = materials.get(materialRefKey(resourceRef));
    if (databaseMaterial && typeof databaseMaterial.databaseId === "string") {
      await cleanupD1(databaseMaterial.databaseId);
    }
    throw cause;
  }
};

const cleanupD1 = async (databaseId) => {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(
      accountId,
    )}/d1/database/${encodeURIComponent(databaseId)}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
    },
  );
  if (!response.ok && response.status !== 404) {
    throw new Error(`cleanup failed with HTTP ${response.status}`);
  }
};

await run();
