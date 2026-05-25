/**
 * ProviderRegistry — module-private. Resolves `endpointRef` and
 * `credentialRef` strings on `LlmRoute` (see `llm.ts`) into concrete
 * URLs and Bearer tokens at call time.
 *
 * Why the indirection:
 *
 *   - **Ledger never carries secrets.** `LlmRoute` is what we
 *     fingerprint into `llm.structured.evidence` events (spec-25 §3).
 *     If `route` carried a raw API key, every admission decision row
 *     would either leak the key or require lossy redaction.
 *   - **Credentials are external state** (INV-9 spirit, formalized in
 *     INV-8 revision in spec-24): they live in wrangler secrets / env
 *     bindings, addressed by symbolic ref. Routes are stable identity
 *     across deploys; secret rotation does not invalidate evidence.
 *   - **App-controlled mapping.** Each AgentDOBase subclass populates
 *     its registry from its own env (or wrangler secrets) via the
 *     protected `provideRegistry()` hook.
 *
 * Errors (EndpointNotFound / CredentialNotFound) are config errors,
 * not transport failures. They escape to Promise rejection rather
 * than routing through `agent.aborted.upstream_failure`.
 */

import { Context, Data, Effect, Layer } from "effect";

export class EndpointNotFound extends Data.TaggedError(
  "agent_os.endpoint_not_found",
)<{
  readonly ref: string;
}> {}

export class CredentialNotFound extends Data.TaggedError(
  "agent_os.credential_not_found",
)<{
  readonly ref: string;
}> {}

export class ProviderRegistry extends Context.Tag(
  "@agent-os/ProviderRegistry",
)<
  ProviderRegistry,
  {
    readonly resolveEndpoint: (
      ref: string,
    ) => Effect.Effect<string, EndpointNotFound>;
    readonly resolveCredential: (
      ref: string,
    ) => Effect.Effect<string, CredentialNotFound>;
  }
>() {}

export interface ProviderRegistryConfig {
  readonly endpoints: Readonly<Record<string, string>>;
  readonly credentials: Readonly<Record<string, string>>;
}

export const ProviderRegistryLive = (
  config: ProviderRegistryConfig,
): Layer.Layer<ProviderRegistry> =>
  Layer.succeed(ProviderRegistry, {
    resolveEndpoint: (ref) => {
      const value = config.endpoints[ref];
      if (value === undefined) {
        return Effect.fail(new EndpointNotFound({ ref }));
      }
      return Effect.succeed(value);
    },
    resolveCredential: (ref) => {
      const value = config.credentials[ref];
      if (value === undefined) {
        return Effect.fail(new CredentialNotFound({ ref }));
      }
      return Effect.succeed(value);
    },
  });

/** Empty registry — for apps using only cf-ai-binding (no external routes). */
export const ProviderRegistryEmpty = ProviderRegistryLive({
  endpoints: {},
  credentials: {},
});
