import { Cause, Effect, Exit, Option } from "effect";
import { describe, expect, it, vi } from "@effect/vitest";
import { makePreClaim } from "@agent-os/kernel/effect-claim";
import {
  bindingMaterialRef,
  credentialMaterialRef,
  externalResourceMaterialRef,
  materialRefKey,
  type MaterialRef,
} from "@agent-os/kernel/material-ref";
import type { RefResolver } from "@agent-os/kernel/ref-resolver";

import {
  CLOUDFLARE_RESOURCE_AUTHORITIES,
  makeCloudflareD1ResourceCarrier,
  type CloudflareD1Fetch,
  type CloudflareD1FetchInit,
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

const d1ResourceRef = externalResourceMaterialRef({
  provider: "cloudflare",
  resourceKind: "d1",
  ref: "tenant/d1/main",
});

const d1BindingRef = bindingMaterialRef({
  provider: "cloudflare",
  bindingKind: "d1",
  ref: "DB",
});

const claimFor = (
  step: "provision" | "bind" | "mutate" | "destroy",
  authorityRef = step === "provision"
    ? CLOUDFLARE_RESOURCE_AUTHORITIES.PROVISION
    : step === "bind"
      ? CLOUDFLARE_RESOURCE_AUTHORITIES.BIND
      : step === "mutate"
        ? CLOUDFLARE_RESOURCE_AUTHORITIES.MUTATE
        : CLOUDFLARE_RESOURCE_AUTHORITIES.DESTROY,
) =>
  makePreClaim({
    operationRef: `cf-d1:subject:${step}`,
    scopeRef: {
      kind: "external",
      scopeId: "cloudflare/tenant/d1/main",
      systemRef: "cloudflare",
    },
    authorityRef,
    originRef: {
      originId: "@agent-os/cloudflare-resource",
      originKind: "extension_package",
    },
  });

const resolverFor = (entries: ReadonlyArray<readonly [MaterialRef, unknown]>): RefResolver => {
  const materials = new Map(entries.map(([ref, value]) => [materialRefKey(ref), value]));
  return {
    material: (ref: MaterialRef) => materials.get(materialRefKey(ref)) ?? null,
  };
};

const standardMaterials = () =>
  new Map<string, unknown>([
    [materialRefKey(credentialRef), "secret-cloudflare-token"],
    [materialRefKey(accountRef), { accountId: "acct-123" }],
    [materialRefKey(d1BindingRef), { bindingName: "DB" }],
  ]);

const resolverFromMap = (materials: Map<string, unknown>): RefResolver => ({
  material: (ref: MaterialRef) => materials.get(materialRefKey(ref)) ?? null,
});

const jsonResponse = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

describe("@agent-os/cloudflare-resource D1 live carrier", () => {
  it.effect("provisions, binds, mutates, and destroys D1 with symbolic ledger payloads", () =>
    Effect.gen(function* () {
      const requests: Array<{ readonly url: string; readonly init: CloudflareD1FetchInit }> = [];
      const fetch: CloudflareD1Fetch = async (url, init) => {
        requests.push({ url, init });
        if (url.endsWith("/accounts/acct-123/d1/database") && init.method === "POST") {
          return jsonResponse(200, {
            success: true,
            result: { uuid: "db-created", leaked: "raw-provider-secret" },
          });
        }
        if (url.endsWith("/accounts/acct-123/d1/database/db-created") && init.method === "GET") {
          return jsonResponse(200, { success: true, result: { uuid: "db-created" } });
        }
        if (
          url.endsWith("/accounts/acct-123/d1/database/db-created/query") &&
          init.method === "POST"
        ) {
          return jsonResponse(200, { success: true, result: [{ success: true }] });
        }
        if (url.endsWith("/accounts/acct-123/d1/database/db-created") && init.method === "DELETE") {
          return jsonResponse(200, { success: true, result: {} });
        }
        return jsonResponse(404, { success: false, errors: [{ message: "unexpected path" }] });
      };
      const materials = standardMaterials();
      const carrier = makeCloudflareD1ResourceCarrier({
        fetch,
        resolver: resolverFromMap(materials),
        carrierRef: "cloudflare-d1-test",
        recordMaterial: (ref, material) => {
          materials.set(materialRefKey(ref), material);
        },
        resolveMutationInput: async (inputRef) =>
          inputRef === "mutation://create-table"
            ? { sql: "CREATE TABLE t (id INTEGER PRIMARY KEY)" }
            : null,
      });

      const provisioned = yield* carrier.provision({
        claim: claimFor("provision"),
        subjectRef: "res-1",
        resourceKind: "d1",
        resourceName: "test-db",
        credentialRef,
        accountRef,
        resourceRef: d1ResourceRef,
      });
      const bound = yield* carrier.bind({
        claim: claimFor("bind"),
        subjectRef: "res-1",
        credentialRef,
        accountRef,
        resourceRef: d1ResourceRef,
        bindingRef: d1BindingRef,
      });
      const mutation = yield* carrier.mutate({
        claim: claimFor("mutate"),
        subjectRef: "res-1",
        credentialRef,
        accountRef,
        resourceRef: d1ResourceRef,
        bindingRef: d1BindingRef,
        mutationKind: "d1.exec",
        inputRef: "mutation://create-table",
        fingerprint: "sha256:test-fingerprint",
      });
      const destroyed = yield* carrier.destroy({
        claim: claimFor("destroy"),
        subjectRef: "res-1",
        credentialRef,
        accountRef,
        resourceRef: d1ResourceRef,
        reason: "manual",
      });

      expect(provisioned).toMatchObject({
        subjectRef: "res-1",
        resourceKind: "d1",
        resourceRef: {
          kind: "external_resource",
          provider: "cloudflare",
          resourceKind: "d1",
          ref: "tenant/d1/main",
        },
        accountRef,
        proofRef: expect.stringMatching(/^proof:\/\/cloudflare\/d1\/provision\/[a-f0-9]{8}$/),
        claim: {
          phase: "lived",
          anchorRef: {
            anchorId: expect.stringMatching(/^proof:\/\/cloudflare\/d1\/provision\/[a-f0-9]{8}$/),
            carrierRef: "cloudflare-d1-test",
          },
        },
      });
      expect(bound).toMatchObject({
        subjectRef: "res-1",
        resourceRef: d1ResourceRef,
        bindingRef: d1BindingRef,
        proofRef: expect.stringMatching(/^proof:\/\/cloudflare\/d1\/bind\/[a-f0-9]{8}$/),
      });
      expect(mutation).toMatchObject({
        subjectRef: "res-1",
        resourceRef: d1ResourceRef,
        mutationKind: "d1.exec",
        mutationRef: "mutation://create-table",
        proofRef: expect.stringMatching(/^proof:\/\/cloudflare\/d1\/mutate\/[a-f0-9]{8}$/),
        fingerprint: "sha256:test-fingerprint",
      });
      expect(destroyed).toMatchObject({
        subjectRef: "res-1",
        resourceRef: d1ResourceRef,
        proofRef: expect.stringMatching(/^proof:\/\/cloudflare\/d1\/destroy\/[a-f0-9]{8}$/),
        reason: "manual",
      });
      expect(provisioned.claim.anchorRef.anchorId).toBe(provisioned.proofRef);
      expect(bound.claim.anchorRef.anchorId).toBe(bound.proofRef);
      expect(mutation.claim.anchorRef.anchorId).toBe(mutation.proofRef);
      expect(destroyed.claim.anchorRef.anchorId).toBe(destroyed.proofRef);
      expect(JSON.stringify([provisioned, bound, mutation, destroyed])).not.toContain(
        "secret-cloudflare-token",
      );
      expect(JSON.stringify([provisioned, bound, mutation, destroyed])).not.toContain(
        "CREATE TABLE",
      );
      expect(JSON.stringify([provisioned, bound, mutation, destroyed])).not.toContain("acct-123");
      expect(JSON.stringify([provisioned, bound, mutation, destroyed])).not.toContain("db-created");
      expect(JSON.stringify([provisioned, bound, mutation, destroyed])).not.toContain(
        "raw-provider-secret",
      );
      expect(requests).toEqual([
        {
          url: "https://api.cloudflare.com/client/v4/accounts/acct-123/d1/database",
          init: {
            method: "POST",
            headers: {
              Authorization: "Bearer secret-cloudflare-token",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ name: "test-db" }),
          },
        },
        {
          url: "https://api.cloudflare.com/client/v4/accounts/acct-123/d1/database/db-created",
          init: {
            method: "GET",
            headers: {
              Authorization: "Bearer secret-cloudflare-token",
            },
          },
        },
        {
          url: "https://api.cloudflare.com/client/v4/accounts/acct-123/d1/database/db-created/query",
          init: {
            method: "POST",
            headers: {
              Authorization: "Bearer secret-cloudflare-token",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ sql: "CREATE TABLE t (id INTEGER PRIMARY KEY)" }),
          },
        },
        {
          url: "https://api.cloudflare.com/client/v4/accounts/acct-123/d1/database/db-created",
          init: {
            method: "DELETE",
            headers: {
              Authorization: "Bearer secret-cloudflare-token",
            },
          },
        },
      ]);
    }),
  );

  it.effect("fails closed when required credential material is unavailable", () =>
    Effect.gen(function* () {
      const fetch = vi.fn<CloudflareD1Fetch>();
      const carrier = makeCloudflareD1ResourceCarrier({
        fetch,
        resolver: resolverFor([
          [accountRef, { accountId: "acct-123" }],
          [d1BindingRef, { bindingName: "DB" }],
        ]),
        resolveMutationInput: async () => null,
      });

      const failure = expectFailure(
        yield* Effect.exit(
          carrier.provision({
            claim: claimFor("provision"),
            subjectRef: "res-1",
            resourceKind: "d1",
            resourceName: "test-db",
            credentialRef,
            accountRef,
          }),
        ),
      );

      expect(failure).toMatchObject({
        code: "MaterialUnavailable",
        step: "provision",
        reason: "cloudflare_api credential material is unavailable",
        claim: {
          phase: "rejected",
          rejectionRef: {
            rejectionKind: "resource_denied",
            reason: "cloudflare_api credential material is unavailable",
          },
        },
      });
      expect(fetch).not.toHaveBeenCalled();
    }),
  );

  it.effect("fails closed when mutation input material is unavailable", () =>
    Effect.gen(function* () {
      const fetch = vi.fn<CloudflareD1Fetch>();
      const carrier = makeCloudflareD1ResourceCarrier({
        fetch,
        resolver: resolverFor([
          [credentialRef, "secret-cloudflare-token"],
          [accountRef, { accountId: "acct-123" }],
          [d1ResourceRef, { databaseId: "db-created" }],
          [d1BindingRef, { bindingName: "DB" }],
        ]),
        resolveMutationInput: async () => null,
      });

      const failure = expectFailure(
        yield* Effect.exit(
          carrier.mutate({
            claim: claimFor("mutate"),
            subjectRef: "res-1",
            credentialRef,
            accountRef,
            resourceRef: d1ResourceRef,
            bindingRef: d1BindingRef,
            mutationKind: "d1.exec",
            inputRef: "mutation://missing",
          }),
        ),
      );

      expect(failure).toMatchObject({
        code: "MaterialUnavailable",
        step: "mutate",
        reason: "cloudflare_d1_mutation_input_unavailable",
      });
      expect(fetch).not.toHaveBeenCalled();
    }),
  );

  it.effect("redacts raw provider failures from rejected claims", () =>
    Effect.gen(function* () {
      const carrier = makeCloudflareD1ResourceCarrier({
        fetch: async () =>
          jsonResponse(500, {
            success: false,
            errors: [{ message: "raw provider body secret-cloudflare-token" }],
          }),
        resolver: resolverFor([
          [credentialRef, "secret-cloudflare-token"],
          [accountRef, { accountId: "acct-123" }],
          [d1ResourceRef, { databaseId: "db-created" }],
          [d1BindingRef, { bindingName: "DB" }],
        ]),
        resolveMutationInput: async () => ({ sql: "DROP TABLE private_data" }),
      });

      const failure = expectFailure(
        yield* Effect.exit(
          carrier.mutate({
            claim: claimFor("mutate"),
            subjectRef: "res-1",
            credentialRef,
            accountRef,
            resourceRef: d1ResourceRef,
            bindingRef: d1BindingRef,
            mutationKind: "d1.exec",
            inputRef: "mutation://drop-table",
          }),
        ),
      );

      expect(failure).toMatchObject({
        code: "MutationFailed",
        step: "mutate",
        reason: "cloudflare_d1_mutate_http_500",
        claim: {
          phase: "rejected",
          rejectionRef: {
            rejectionKind: "provider_rejected",
            reason: "cloudflare_d1_mutate_http_500",
          },
        },
      });
      expect(JSON.stringify(failure)).not.toContain("secret-cloudflare-token");
      expect(JSON.stringify(failure)).not.toContain("DROP TABLE");
      expect(JSON.stringify(failure)).not.toContain("raw provider body");
      expect(JSON.stringify(failure)).not.toContain("acct-123");
      expect(JSON.stringify(failure)).not.toContain("db-created");
    }),
  );
});
