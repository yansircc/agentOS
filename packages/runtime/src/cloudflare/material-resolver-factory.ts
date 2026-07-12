import type { RefResolver } from "@agent-os/core/ref-resolver";

export type CloudflareMaterialResolverBindings = Readonly<Record<string, unknown>>;

/**
 * App-owned Cloudflare binding adapter for generated runtimes.
 *
 * The generated Durable Object passes raw platform bindings to this factory.
 * The returned resolver owns tenant authorization, version checks, storage,
 * and the scoped material resource lifecycle.
 *
 * @public
 */
export interface CloudflareMaterialResolverFactory {
  readonly create: (bindings: CloudflareMaterialResolverBindings) => RefResolver;
}

/**
 * Defines a typed app-owned factory while erasing its binding shape only at
 * the generated Cloudflare host boundary.
 *
 * @agentosPrimitive primitive.cloudflare-do.defineCloudflareMaterialResolverFactory
 * @agentosInvariant invariant.host.fact-owner
 * @agentosDocs docs/packages/runtime.md
 * @public
 */
export const defineCloudflareMaterialResolverFactory = <Env extends object>(
  create: (env: Env) => RefResolver,
): CloudflareMaterialResolverFactory =>
  Object.freeze({
    create: (bindings: CloudflareMaterialResolverBindings) => create(bindings as Env),
  });
