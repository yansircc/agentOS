import { Effect, ManagedRuntime } from "effect";
import { describe, expect, it } from "@effect/vitest";

import { makePreClaim } from "../src/effect-claim";
import {
  bindingMaterialRef,
  credentialMaterialRef,
  endpointMaterialRef,
  externalResourceMaterialRef,
  isEffectAuthorityContract,
  isMaterialRef,
  isMaterialRequirement,
  materialRefSatisfiesRequirement,
  materialRefKey,
  materialRequirement,
} from "../src/material-ref";
import { RefResolverLive, RefResolverService, resolveStringMaterial } from "../src/ref-resolver";

describe("MaterialRef algebra", () => {
  it("validates only symbolic material refs", () => {
    expect(isMaterialRef(credentialMaterialRef("CF_API_TOKEN"))).toBe(true);
    expect(isMaterialRef(endpointMaterialRef("openrouter"))).toBe(true);
    expect(
      isMaterialRef(
        bindingMaterialRef({
          provider: "cloudflare",
          bindingKind: "d1",
          ref: "APP_DB",
        }),
      ),
    ).toBe(true);
    expect(
      isMaterialRef(
        externalResourceMaterialRef({
          provider: "wordpress",
          resourceKind: "site",
          ref: "site/acme",
        }),
      ),
    ).toBe(true);

    expect(isMaterialRef({ kind: "credential", ref: "" })).toBe(false);
    expect(
      isMaterialRef({
        kind: "credential",
        ref: "CF_API_TOKEN",
        value: "resolved-secret",
      }),
    ).toBe(false);
    expect(
      isMaterialRef({
        kind: "binding",
        provider: "cloudflare",
        bindingKind: "d1",
        ref: "APP_DB",
        handle: {},
      }),
    ).toBe(false);
  });

  it("keeps requirement filters kind-specific", () => {
    expect(
      isMaterialRequirement(
        materialRequirement({
          slot: "api_token",
          kind: "credential",
          provider: "cloudflare",
          purpose: "deploy",
        }),
      ),
    ).toBe(true);
    expect(
      isMaterialRequirement(
        materialRequirement({
          slot: "database",
          kind: "binding",
          provider: "cloudflare",
          bindingKind: "d1",
        }),
      ),
    ).toBe(true);
    expect(
      isMaterialRequirement({
        slot: "api_token",
        kind: "credential",
        required: true,
        bindingKind: "d1",
      }),
    ).toBe(false);
    expect(
      isMaterialRequirement({
        slot: "endpoint",
        kind: "endpoint",
        required: true,
        provider: "cloudflare",
      }),
    ).toBe(false);
  });

  it("matches symbolic refs against requirement filters without resolving values", () => {
    const deployToken = materialRequirement({
      slot: "api_token",
      kind: "credential",
      provider: "cloudflare",
      purpose: "deploy",
    });

    expect(
      materialRefSatisfiesRequirement(
        credentialMaterialRef("CF_API_TOKEN", { provider: "cloudflare", purpose: "deploy" }),
        deployToken,
      ),
    ).toBe(true);
    expect(
      materialRefSatisfiesRequirement(
        credentialMaterialRef("CF_API_TOKEN", { provider: "cloudflare", purpose: "read" }),
        deployToken,
      ),
    ).toBe(false);
    expect(materialRefSatisfiesRequirement(endpointMaterialRef("openai"), deployToken)).toBe(false);
  });

  it("derives stable keys without resolving material", () => {
    expect(
      materialRefKey(
        bindingMaterialRef({
          provider: "cloudflare",
          bindingKind: "durable_object",
          ref: "AGENT/DO",
        }),
      ),
    ).toBe("binding:cloudflare:durable_object:AGENT%2FDO");
    expect(
      materialRefKey(
        externalResourceMaterialRef({
          provider: "wordpress",
          resourceKind: "site",
          ref: "site/acme.test",
        }),
      ),
    ).toBe("external_resource:wordpress:site:site%2Facme.test");
  });

  it("binds required materials to an authority contract", () => {
    const contract = {
      effectAuthorityRef: {
        authorityId: "cf.deploy_worker",
        authorityClass: "deploy",
      },
      requiredMaterials: [
        materialRequirement({
          slot: "api_token",
          kind: "credential",
          provider: "cloudflare",
          purpose: "deploy",
        }),
        materialRequirement({
          slot: "account",
          kind: "external_resource",
          provider: "cloudflare",
          resourceKind: "account",
          required: false,
        }),
      ],
    };

    expect(isEffectAuthorityContract(contract)).toBe(true);
    expect(isEffectAuthorityContract({ ...contract, requiredMaterials: [{}] })).toBe(false);
  });

  it("material refs are resolver input, not PreClaim identity", () => {
    const claim = makePreClaim({
      operationRef: "deploy:worker:acme",
      scopeRef: {
        kind: "external",
        scopeId: "cf/account/acme",
        systemRef: "cloudflare",
      },
      effectAuthorityRef: {
        authorityId: "cf.deploy_worker",
        authorityClass: "deploy",
      },
      originRef: {
        originId: "submit/1",
        originKind: "submit",
      },
    });
    const personalToken = credentialMaterialRef("CF_USER_TOKEN", {
      provider: "cloudflare",
    });
    const orgToken = credentialMaterialRef("CF_ORG_TOKEN", {
      provider: "cloudflare",
    });

    expect(claim.operationRef).toBe("deploy:worker:acme");
    expect(materialRefKey(personalToken)).not.toBe(materialRefKey(orgToken));
    expect("materialRef" in claim).toBe(false);
  });

  it("resolves non-secret material through RefResolver material axis", async () => {
    const runtime = ManagedRuntime.make(
      RefResolverLive({
        material: (ref) => {
          switch (materialRefKey(ref)) {
            case "endpoint:_:openrouter":
              return "https://openrouter.ai/api/v1";
            case "credential:_:OPENROUTER_KEY":
              return "secret";
            case "binding:cloudflare:d1:APP_DB":
              return { binding: "d1" };
            default:
              return null;
          }
        },
      }),
    );

    const resolved = await runtime.runPromise(
      Effect.gen(function* () {
        const refs = yield* RefResolverService;
        return {
          endpoint: yield* refs.material(endpointMaterialRef("openrouter")),
          credential: yield* refs.material(credentialMaterialRef("OPENROUTER_KEY")),
          binding: yield* refs.material(
            bindingMaterialRef({
              provider: "cloudflare",
              bindingKind: "d1",
              ref: "APP_DB",
            }),
          ),
        };
      }),
    );

    expect(resolved).toEqual({
      endpoint: "https://openrouter.ai/api/v1",
      credential: "secret",
      binding: { binding: "d1" },
    });

    await runtime.dispose();
  });

  it("rejects non-string material at string-only transport boundaries", async () => {
    const runtime = ManagedRuntime.make(
      RefResolverLive({
        material: (ref) =>
          ref.kind === "endpoint" && ref.ref === "not-a-string" ? { url: "x" } : null,
      }),
    );

    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const refs = yield* RefResolverService;
        return yield* Effect.result(
          resolveStringMaterial(refs, endpointMaterialRef("not-a-string")),
        );
      }),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure).toMatchObject({
        kind: "endpoint",
        ref: "endpoint:_:not-a-string",
      });
    }

    await runtime.dispose();
  });
});
