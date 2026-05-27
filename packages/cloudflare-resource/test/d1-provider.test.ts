import { Cause, Effect, Exit, Option } from "effect";
import { makePreClaim } from "@agent-os/core/effect-claim";
import {
  bindingMaterialRef,
  credentialMaterialRef,
  externalResourceMaterialRef,
  type MaterialRef,
} from "@agent-os/core/material-ref";
import type { RefResolver } from "@agent-os/core/ref-resolver";

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
  throw new Error("expected failed exit");
};

const credentialRef = credentialMaterialRef("tenant/cloudflare/api-token", {
  provider: "cloudflare",
  purpose: "cloudflare_api",
});

const accountRef = externalResourceMaterialRef({
  provider: "cloudflare",
  resourceKind: "account",
  ref: "acct-123",
});

const d1ResourceRef = externalResourceMaterialRef({
  provider: "cloudflare",
  resourceKind: "d1",
  ref: "db-123",
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
      scopeId: "cloudflare/acct-123/d1/db-123",
      systemRef: "cloudflare",
    },
    authorityRef,
    originRef: {
      originId: "@agent-os/cloudflare-resource",
      originKind: "extension_package",
    },
  });

const resolverWith = (material: string | null): RefResolver => ({
  material: (ref: MaterialRef) => (ref.kind === "credential" ? material : null),
});

const jsonResponse = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

describe("@agent-os/cloudflare-resource D1 live carrier", () => {
  it("provisions, binds, mutates, and destroys D1 with symbolic ledger payloads", async () => {
    const requests: Array<{ readonly url: string; readonly init: CloudflareD1FetchInit }> = [];
    const fetch: CloudflareD1Fetch = async (url, init) => {
      requests.push({ url, init });
      if (url.endsWith("/accounts/acct-123/d1/database") && init.method === "POST") {
        return jsonResponse(200, { success: true, result: { uuid: "db-created" } });
      }
      if (url.endsWith("/accounts/acct-123/d1/database/db-123/query") && init.method === "POST") {
        return jsonResponse(200, { success: true, result: [{ success: true }] });
      }
      if (url.endsWith("/accounts/acct-123/d1/database/db-123") && init.method === "DELETE") {
        return jsonResponse(200, { success: true, result: {} });
      }
      return jsonResponse(404, { success: false, errors: [{ message: "unexpected path" }] });
    };
    const carrier = makeCloudflareD1ResourceCarrier({
      fetch,
      resolver: resolverWith("secret-cloudflare-token"),
      carrierRef: "cloudflare-d1-test",
      resolveMutationInput: async (inputRef) =>
        inputRef === "mutation://create-table"
          ? { sql: "CREATE TABLE t (id INTEGER PRIMARY KEY)" }
          : null,
    });

    const provisioned = await Effect.runPromise(
      carrier.provision({
        claim: claimFor("provision"),
        subjectRef: "res-1",
        resourceKind: "d1",
        resourceName: "test-db",
        credentialRef,
        accountRef,
      }),
    );
    const bound = await Effect.runPromise(
      carrier.bind({
        claim: claimFor("bind"),
        subjectRef: "res-1",
        credentialRef,
        accountRef,
        resourceRef: d1ResourceRef,
        bindingRef: d1BindingRef,
      }),
    );
    const mutation = await Effect.runPromise(
      carrier.mutate({
        claim: claimFor("mutate"),
        subjectRef: "res-1",
        credentialRef,
        accountRef,
        resourceRef: d1ResourceRef,
        mutationKind: "d1.exec",
        inputRef: "mutation://create-table",
        fingerprint: "sha256:test-fingerprint",
      }),
    );
    const destroyed = await Effect.runPromise(
      carrier.destroy({
        claim: claimFor("destroy"),
        subjectRef: "res-1",
        credentialRef,
        accountRef,
        resourceRef: d1ResourceRef,
        reason: "manual",
      }),
    );

    expect(provisioned).toMatchObject({
      subjectRef: "res-1",
      resourceKind: "d1",
      resourceRef: {
        kind: "external_resource",
        provider: "cloudflare",
        resourceKind: "d1",
        ref: "db-created",
      },
      accountRef,
      proofRef: "proof://cloudflare/d1/provision/acct-123/db-created/res-1",
      claim: {
        phase: "lived",
        anchorRef: {
          anchorId: "proof://cloudflare/d1/provision/acct-123/db-created/res-1",
          carrierRef: "cloudflare-d1-test",
        },
      },
    });
    expect(bound).toMatchObject({
      subjectRef: "res-1",
      resourceRef: d1ResourceRef,
      bindingRef: d1BindingRef,
      proofRef: "proof://cloudflare/d1/bind/acct-123/db-123/DB",
    });
    expect(mutation).toMatchObject({
      subjectRef: "res-1",
      resourceRef: d1ResourceRef,
      mutationKind: "d1.exec",
      mutationRef: "mutation://create-table",
      proofRef: "proof://cloudflare/d1/mutate/acct-123/db-123/mutation%3A%2F%2Fcreate-table",
      fingerprint: "sha256:test-fingerprint",
    });
    expect(destroyed).toMatchObject({
      subjectRef: "res-1",
      resourceRef: d1ResourceRef,
      proofRef: "proof://cloudflare/d1/destroy/acct-123/db-123/res-1",
      reason: "manual",
    });
    expect(JSON.stringify([provisioned, bound, mutation, destroyed])).not.toContain(
      "secret-cloudflare-token",
    );
    expect(JSON.stringify([provisioned, bound, mutation, destroyed])).not.toContain("CREATE TABLE");
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
        url: "https://api.cloudflare.com/client/v4/accounts/acct-123/d1/database/db-123/query",
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
        url: "https://api.cloudflare.com/client/v4/accounts/acct-123/d1/database/db-123",
        init: {
          method: "DELETE",
          headers: {
            Authorization: "Bearer secret-cloudflare-token",
            "Content-Type": "application/json",
          },
        },
      },
    ]);
  });

  it("fails closed when required credential material is unavailable", async () => {
    const fetch = vi.fn<CloudflareD1Fetch>();
    const carrier = makeCloudflareD1ResourceCarrier({
      fetch,
      resolver: resolverWith(null),
      resolveMutationInput: async () => null,
    });

    const failure = expectFailure(
      await Effect.runPromiseExit(
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
  });

  it("fails closed when mutation input material is unavailable", async () => {
    const fetch = vi.fn<CloudflareD1Fetch>();
    const carrier = makeCloudflareD1ResourceCarrier({
      fetch,
      resolver: resolverWith("secret-cloudflare-token"),
      resolveMutationInput: async () => null,
    });

    const failure = expectFailure(
      await Effect.runPromiseExit(
        carrier.mutate({
          claim: claimFor("mutate"),
          subjectRef: "res-1",
          credentialRef,
          accountRef,
          resourceRef: d1ResourceRef,
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
  });

  it("redacts raw provider failures from rejected claims", async () => {
    const carrier = makeCloudflareD1ResourceCarrier({
      fetch: async () =>
        jsonResponse(500, {
          success: false,
          errors: [{ message: "raw provider body secret-cloudflare-token" }],
        }),
      resolver: resolverWith("secret-cloudflare-token"),
      resolveMutationInput: async () => ({ sql: "DROP TABLE private_data" }),
    });

    const failure = expectFailure(
      await Effect.runPromiseExit(
        carrier.mutate({
          claim: claimFor("mutate"),
          subjectRef: "res-1",
          credentialRef,
          accountRef,
          resourceRef: d1ResourceRef,
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
  });
});
