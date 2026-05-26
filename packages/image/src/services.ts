import { Context, Data, Effect, Layer } from "effect";

/** Minimal `env.AI.run` shape consumed by the CF AI image adapter. */
export interface ImageAi {
  readonly run: (
    model: string,
    input: unknown,
    options?: unknown,
  ) => Promise<unknown>;
}

export class ImageAiBinding extends Context.Tag(
  "@agent-os/image/ImageAiBinding",
)<ImageAiBinding, ImageAi>() {}

export class ImageEndpointNotFound extends Data.TaggedError(
  "agent_os.image_endpoint_not_found",
)<{
  readonly ref: string;
}> {}

export class ImageCredentialNotFound extends Data.TaggedError(
  "agent_os.image_credential_not_found",
)<{
  readonly ref: string;
}> {}

export class ImageUpstreamFailure extends Data.TaggedError(
  "agent_os.image_upstream_failure",
)<{
  readonly cause: unknown;
}> {}

export class ImageProviderRegistry extends Context.Tag(
  "@agent-os/image/ImageProviderRegistry",
)<
  ImageProviderRegistry,
  {
    readonly resolveEndpoint: (
      ref: string,
    ) => Effect.Effect<string, ImageEndpointNotFound>;
    readonly resolveCredential: (
      ref: string,
    ) => Effect.Effect<string, ImageCredentialNotFound>;
  }
>() {}

export interface ImageProviderRegistryConfig {
  readonly endpoints: Readonly<Record<string, string>>;
  readonly credentials: Readonly<Record<string, string>>;
}

export const ImageProviderRegistryLive = (
  config: ImageProviderRegistryConfig,
): Layer.Layer<ImageProviderRegistry> =>
  Layer.succeed(ImageProviderRegistry, {
    resolveEndpoint: (ref) => {
      const value = config.endpoints[ref];
      if (value === undefined) {
        return Effect.fail(new ImageEndpointNotFound({ ref }));
      }
      return Effect.succeed(value);
    },
    resolveCredential: (ref) => {
      const value = config.credentials[ref];
      if (value === undefined) {
        return Effect.fail(new ImageCredentialNotFound({ ref }));
      }
      return Effect.succeed(value);
    },
  });
