import { Effect, ManagedRuntime, Option } from "effect";
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
import {
  liveResolvedMaterial,
  RefResolverLive,
  RefResolverService,
  RefResolutionFailed,
} from "../../src/ref-resolver";
import { openLive } from "../../src/live-edge";

describe("MaterialRef algebra", () => {
  const truthIdentity = {
    scopeRef: { kind: "conversation" as const, scopeId: "tenant-bound-run" },
    effectAuthorityRef: { authorityId: "agent.run", authorityClass: "runtime" },
  };
  const request = (
    materialRef:
      | ReturnType<typeof credentialMaterialRef>
      | ReturnType<typeof endpointMaterialRef>
      | ReturnType<typeof bindingMaterialRef>,
  ) => ({
    truthIdentity,
    materialRef,
  });
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
        material: ({ materialRef }) => {
          switch (materialRefKey(materialRef)) {
            case "endpoint:_:openrouter":
              return Effect.succeed(
                liveResolvedMaterial({
                  ref: materialRef,
                  version: "v1",
                  value: "https://openrouter.ai/api/v1",
                }),
              );
            case "credential:_:OPENROUTER_KEY":
              return Effect.succeed(
                liveResolvedMaterial({ ref: materialRef, version: "v1", value: "secret" }),
              );
            case "binding:cloudflare:d1:APP_DB":
              return Effect.succeed(
                liveResolvedMaterial({ ref: materialRef, version: "v1", value: { binding: "d1" } }),
              );
            default:
              return Effect.fail(
                new RefResolutionFailed({
                  kind: materialRef.kind,
                  ref: materialRefKey(materialRef),
                  reason: "material_missing",
                }),
              );
          }
        },
      }),
    );

    const resolved = await runtime.runPromise(
      Effect.gen(function* () {
        const refs = yield* RefResolverService;
        const endpoint = yield* refs.material(request(endpointMaterialRef("openrouter")));
        const credential = yield* refs.material(request(credentialMaterialRef("OPENROUTER_KEY")));
        const binding = yield* refs.material(
          request(
            bindingMaterialRef({
              provider: "cloudflare",
              bindingKind: "d1",
              ref: "APP_DB",
            }),
          ),
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
        material: ({ materialRef }) =>
          materialRef.kind === "credential"
            ? Effect.succeed(
                liveResolvedMaterial({
                  ref: materialRef,
                  version: "v1",
                  value: "secret",
                  dispose: () =>
                    Effect.sync(() => disposed.push(`${materialRefKey(materialRef)}:secret`)),
                }),
              )
            : Effect.fail(
                new RefResolutionFailed({
                  kind: materialRef.kind,
                  ref: materialRefKey(materialRef),
                  reason: "material_missing",
                }),
              ),
      }),
    );

    const observed = await runtime.runPromise(
      Effect.gen(function* () {
        const refs = yield* RefResolverService;
        const handle = yield* refs.material(request(credentialMaterialRef("OPENROUTER_KEY")));
        const serialized = JSON.stringify(handle);
        yield* handle.dispose();
        const opened = yield* Effect.acquireUseRelease(
          refs.material(request(credentialMaterialRef("OPENROUTER_KEY"))),
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
      serialized: '{"ref":{"kind":"credential","ref":"OPENROUTER_KEY"},"version":"v1","value":{}}',
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
        material: ({ materialRef }) =>
          materialRef.kind === "endpoint" && materialRef.ref === "not-a-string"
            ? Effect.succeed(
                liveResolvedMaterial({ ref: materialRef, version: "v1", value: { url: "x" } }),
              )
            : Effect.fail(
                new RefResolutionFailed({
                  kind: materialRef.kind,
                  ref: materialRefKey(materialRef),
                  reason: "material_missing",
                }),
              ),
      }),
    );

    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const refs = yield* RefResolverService;
        const ref = endpointMaterialRef("not-a-string");
        return yield* Effect.result(
          Effect.acquireUseRelease(
            refs.material(request(ref)),
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

  it.effect(
    "isolates identical refs through host-bound tenant resolvers and fails forged scope closed",
    () =>
      Effect.gen(function* () {
        const ref = credentialMaterialRef("shared-key");
        const resolverFor = (tenant: string, secret: string) =>
          RefResolverLive({
            material: (resolution) =>
              resolution.truthIdentity.scopeRef.scopeId === tenant
                ? Effect.succeed(
                    liveResolvedMaterial({
                      ref: resolution.materialRef,
                      version: "v1",
                      value: secret,
                    }),
                  )
                : Effect.fail(
                    new RefResolutionFailed({
                      kind: resolution.materialRef.kind,
                      ref: materialRefKey(resolution.materialRef),
                      reason: "material_unauthorized",
                    }),
                  ),
          });
        const requestFor = (tenant: string) => ({
          truthIdentity: {
            scopeRef: { kind: "conversation" as const, scopeId: tenant },
            effectAuthorityRef: { authorityId: "agent.run", authorityClass: "runtime" },
          },
          materialRef: ref,
        });
        const resolve = (tenant: string) =>
          Effect.gen(function* () {
            const resolver = yield* RefResolverService;
            return openLive((yield* resolver.material(requestFor(tenant))).value);
          });
        const forgedResolution = Effect.gen(function* () {
          const resolver = yield* RefResolverService;
          return yield* Effect.result(resolver.material(requestFor("tenant-b")));
        });
        const [a, b, forged] = yield* Effect.all(
          [
            resolve("tenant-a").pipe(Effect.provide(resolverFor("tenant-a", "secret-a"))),
            resolve("tenant-b").pipe(Effect.provide(resolverFor("tenant-b", "secret-b"))),
            forgedResolution.pipe(Effect.provide(resolverFor("tenant-a", "secret-a"))),
          ] as const,
          { concurrency: "unbounded" },
        );

        expect(a).toBe("secret-a");
        expect(b).toBe("secret-b");
        expect(forged).toMatchObject({
          _tag: "Failure",
          failure: { reason: "material_unauthorized" },
        });
      }),
  );

  it("sanitizes synchronous host resolver failures without exposing provider material", async () => {
    const secret = "provider-secret-must-not-escape";
    const runtime = ManagedRuntime.make(
      RefResolverLive({
        material: () => Option.getOrThrowWith(Option.none(), () => new TypeError(secret)),
      }),
    );
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const resolver = yield* RefResolverService;
        return yield* Effect.result(
          resolver.material(request(credentialMaterialRef("OPENROUTER_KEY"))),
        );
      }),
    );

    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { reason: "resolver_failed" },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    await runtime.dispose();
  });
});
