import { Effect, ManagedRuntime } from "effect";
import { describe, expect, it } from "@effect/vitest";

import { makePreClaim } from "../../src/effect-claim";
import type { Authored } from "../../src";
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
} from "../../src/material-ref";
import { RefResolverLive, RefResolverService, RefResolutionFailed } from "../../src/ref-resolver";
import { openLive } from "../../src/live-edge";

describe("MaterialRef algebra", () => {
  it("mints material refs and requirements as authored declarations", () => {
    const ref = credentialMaterialRef("CF_API_TOKEN", {
      provider: "cloudflare",
      purpose: "deploy",
    });
    const authoredRef: Authored<typeof ref.value> = ref;
    expect(authoredRef.value.kind).toBe("credential");
    expect(Object.prototype.propertyIsEnumerable.call(ref, "value")).toBe(false);
    expect(JSON.stringify(ref)).toBe(
      '{"kind":"credential","ref":"CF_API_TOKEN","provider":"cloudflare","purpose":"deploy"}',
    );

    const requirement = materialRequirement({
      slot: "api_token",
      kind: "credential",
      provider: "cloudflare",
      purpose: "deploy",
    });
    const authoredRequirement: Authored<typeof requirement.value> = requirement;
    expect(authoredRequirement.value.slot).toBe("api_token");
    expect(Object.prototype.propertyIsEnumerable.call(requirement, "value")).toBe(false);
    expect(JSON.stringify(requirement)).toBe(
      '{"slot":"api_token","kind":"credential","provider":"cloudflare","purpose":"deploy","required":true}',
    );
  });

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
        const endpoint = yield* refs.material(endpointMaterialRef("openrouter"));
        const credential = yield* refs.material(credentialMaterialRef("OPENROUTER_KEY"));
        const binding = yield* refs.material(
          bindingMaterialRef({
            provider: "cloudflare",
            bindingKind: "d1",
            ref: "APP_DB",
          }),
        );
        return {
          endpoint: openLive(endpoint.value),
          credential: openLive(credential.value),
          binding: openLive(binding.value),
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

  it("captures resolved material as non-serializable Live and disposes it after scoped use", async () => {
    const disposed: string[] = [];
    const runtime = ManagedRuntime.make(
      RefResolverLive({
        material: (ref) => (ref.kind === "credential" ? "secret" : null),
        dispose: ({ ref, material }) => {
          const materialLabel = typeof material === "string" ? material : JSON.stringify(material);
          disposed.push(`${materialRefKey(ref)}:${materialLabel}`);
        },
      }),
    );

    const observed = await runtime.runPromise(
      Effect.gen(function* () {
        const refs = yield* RefResolverService;
        const handle = yield* refs.material(credentialMaterialRef("OPENROUTER_KEY"));
        const serialized = JSON.stringify(handle);
        yield* handle.dispose();
        const opened = yield* Effect.acquireUseRelease(
          refs.material(credentialMaterialRef("OPENROUTER_KEY")),
          (nextHandle) => {
            const value = openLive(nextHandle.value);
            return typeof value === "string"
              ? Effect.succeed(value)
              : Effect.fail(
                  new RefResolutionFailed({
                    kind: "credential",
                    ref: materialRefKey(credentialMaterialRef("OPENROUTER_KEY")),
                    reason: "material_type_mismatch",
                  }),
                );
          },
          (nextHandle) => nextHandle.dispose(),
        );
        return { serialized, opened };
      }),
    );

    expect(observed).toEqual({
      serialized: '{"ref":{"kind":"credential","ref":"OPENROUTER_KEY"},"value":{}}',
      opened: "secret",
    });
    expect(disposed).toEqual([
      "credential:_:OPENROUTER_KEY:secret",
      "credential:_:OPENROUTER_KEY:secret",
    ]);

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
        const ref = endpointMaterialRef("not-a-string");
        return yield* Effect.result(
          Effect.acquireUseRelease(
            refs.material(ref),
            (handle) => {
              const value = openLive(handle.value);
              return typeof value === "string"
                ? Effect.succeed(value)
                : Effect.fail(
                    new RefResolutionFailed({
                      kind: ref.kind,
                      ref: materialRefKey(ref),
                      reason: "material_type_mismatch",
                    }),
                  );
            },
            (handle) => handle.dispose(),
          ),
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
