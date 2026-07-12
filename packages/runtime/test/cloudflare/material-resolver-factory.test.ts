import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { liveResolvedMaterial, type MaterialResolutionRequest } from "@agent-os/core/ref-resolver";
import { openLive } from "@agent-os/core/live-edge";
import { defineCloudflareMaterialResolverFactory } from "../../src/cloudflare/material-resolver-factory";

describe("Cloudflare material resolver factory", () => {
  it.effect("adapts typed app bindings without changing the resolver resource lifecycle", () =>
    Effect.gen(function* () {
      const disposed: string[] = [];
      const factory = defineCloudflareMaterialResolverFactory<{
        readonly materials: Readonly<Record<string, string>>;
      }>((env) => ({
        material: (request: MaterialResolutionRequest) => {
          const value = env.materials[request.materialRef.ref];
          return value === undefined
            ? Effect.die("fixture material missing")
            : Effect.succeed(
                liveResolvedMaterial({
                  ref: request.materialRef,
                  version: "v1",
                  value,
                  dispose: () => Effect.sync(() => disposed.push(request.materialRef.ref)),
                }),
              );
        },
      }));

      const resolver = factory.create({ materials: { credential: "secret" } });
      const request: MaterialResolutionRequest = {
        truthIdentity: {
          scopeRef: { kind: "external", scopeId: "tenant-a", systemRef: "host" },
          effectAuthorityRef: { authorityClass: "agent", authorityId: "material-test" },
        },
        materialRef: { kind: "credential", ref: "credential" },
      };
      const handle = yield* resolver.material(request);

      expect(openLive(handle.value)).toBe("secret");
      expect(handle.version).toBe("v1");
      yield* handle.dispose();
      expect(disposed).toEqual(["credential"]);
    }),
  );
});
