#!/usr/bin/env bun

import { Effect } from "effect";
import { makePreClaim } from "@agent-os/core/effect-claim";
import {
  bindingMaterialRef,
  credentialMaterialRef,
  externalResourceMaterialRef,
} from "@agent-os/core/material-ref";
import {
  CLOUDFLARE_RESOURCE_AUTHORITIES,
  makeCloudflareD1ResourceCarrier,
  projectCloudflareResource,
} from "../src/index.ts";

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
  ref: accountId,
});

const bindingRef = bindingMaterialRef({
  provider: "cloudflare",
  bindingKind: "d1",
  ref: `${safeName(scopePrefix).replaceAll("-", "_").toUpperCase()}_D1_SMOKE`,
});

const resolver = {
  material: (ref) => {
    if (ref.kind === "credential" && ref.ref === credentialRef.ref) return apiToken;
    return null;
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
  resolveMutationInput: (inputRef) => mutationInputs.get(inputRef) ?? null,
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
    authorityRef:
      step === "provision"
        ? CLOUDFLARE_RESOURCE_AUTHORITIES.PROVISION
        : step === "bind"
          ? CLOUDFLARE_RESOURCE_AUTHORITIES.BIND
          : step === "mutate"
            ? CLOUDFLARE_RESOURCE_AUTHORITIES.MUTATE
            : CLOUDFLARE_RESOURCE_AUTHORITIES.DESTROY,
    originRef: {
      originId: "@agent-os/cloudflare-resource.d1-live-smoke",
      originKind: "test",
    },
  });

const redactionScan = (label, value) => {
  const serialized = JSON.stringify(value);
  if (serialized.includes(apiToken)) {
    throw new Error(`${label} leaked resolved credential material`);
  }
  if (serialized.includes("CREATE TABLE")) {
    throw new Error(`${label} leaked resolved mutation SQL`);
  }
};

const run = async () => {
  let resourceRef;
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
        bindingRef,
      }),
    );
    resourceRef = provisioned.resourceRef;
    events.push({
      id: events.length + 1,
      kind: "cf_resource.resource.provisioned",
      payload: provisioned,
    });

    const bound = await Effect.runPromise(
      carrier.bind({
        claim: claimFor("bind"),
        subjectRef: resourceName,
        credentialRef,
        accountRef,
        resourceRef,
        bindingRef,
      }),
    );
    events.push({ id: events.length + 1, kind: "cf_resource.resource.bound", payload: bound });

    const mutationRef = `mutation://${resourceName}/create-table`;
    const mutated = await Effect.runPromise(
      carrier.mutate({
        claim: claimFor("mutate"),
        subjectRef: resourceName,
        credentialRef,
        accountRef,
        resourceRef,
        mutationKind: "d1.exec",
        inputRef: mutationRef,
        fingerprint: `sha256:${resourceName}`,
      }),
    );
    events.push({
      id: events.length + 1,
      kind: "cf_resource.mutation.recorded",
      payload: mutated,
    });

    const destroyed = await Effect.runPromise(
      carrier.destroy({
        claim: claimFor("destroy"),
        subjectRef: resourceName,
        credentialRef,
        accountRef,
        resourceRef,
        reason: "manual",
      }),
    );
    events.push({
      id: events.length + 1,
      kind: "cf_resource.resource.destroyed",
      payload: destroyed,
    });

    const projection = projectCloudflareResource(events, resourceName);
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
    if (resourceRef !== undefined) {
      await cleanupD1(resourceRef.ref);
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
