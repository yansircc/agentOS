import { Context, Data, Effect, Layer } from "effect";
import { RefResolutionFailed, type RefResolver } from "@agent-os/core/ref-resolver";

/** Minimal `env.AI.run` shape consumed by the CF AI image adapter. */
export interface ImageAi {
  readonly run: (model: string, input: unknown, options?: unknown) => Promise<unknown>;
}

export class ImageAiBinding extends Context.Tag("@agent-os/image/ImageAiBinding")<
  ImageAiBinding,
  ImageAi
>() {}

export class ImageUpstreamFailure extends Data.TaggedError("agent_os.image_upstream_failure")<{
  readonly cause: unknown;
}> {}

export class ImageRefResolver extends Context.Tag("@agent-os/image/ImageRefResolver")<
  ImageRefResolver,
  {
    readonly endpoint: (ref: string) => Effect.Effect<string, RefResolutionFailed>;
    readonly credential: (ref: string) => Effect.Effect<string, RefResolutionFailed>;
  }
>() {}

export const ImageRefResolverLive = (resolver: RefResolver): Layer.Layer<ImageRefResolver> =>
  Layer.succeed(ImageRefResolver, {
    endpoint: (ref) => {
      const value = resolver.endpoint(ref);
      if (value === null) {
        return Effect.fail(new RefResolutionFailed({ kind: "endpoint", ref }));
      }
      return Effect.succeed(value);
    },
    credential: (ref) => {
      const value = resolver.credential(ref);
      if (value === null) {
        return Effect.fail(new RefResolutionFailed({ kind: "credential", ref }));
      }
      return Effect.succeed(value);
    },
  });
