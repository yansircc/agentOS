import { Effect } from "effect";
import { getImageProtocolAdapter } from "./adapters/registry";
import {
  ImageAiBinding,
  ImageCredentialNotFound,
  ImageEndpointNotFound,
  ImageProviderRegistry,
  ImageUpstreamFailure,
} from "./services";
import type {
  CfAiBindingImageBody,
  GenerateImageSpec,
  ImageProviderBody,
  ImageResult,
  ImageRoute,
  OpenAIChatCompatibleImageBody,
} from "./types";

const dispatchImageProvider = (
  route: ImageRoute,
  body: ImageProviderBody<ImageRoute["kind"]>,
): Effect.Effect<
  unknown,
  ImageUpstreamFailure | ImageEndpointNotFound | ImageCredentialNotFound,
  ImageAiBinding | ImageProviderRegistry
> => {
  switch (route.kind) {
    case "openai-chat-compatible-image":
      return Effect.gen(function* () {
        const registry = yield* ImageProviderRegistry;
        const endpoint = yield* registry.resolveEndpoint(route.endpointRef);
        const apiKey = yield* registry.resolveCredential(route.credentialRef);
        const url = `${endpoint.replace(/\/$/, "")}/chat/completions`;
        const fullBody = {
          model: route.modelId,
          ...(body as OpenAIChatCompatibleImageBody),
        };
        return yield* Effect.tryPromise({
          try: async () => {
            const res = await fetch(url, {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(fullBody),
            });
            if (!res.ok) {
              const text = await res.text().catch(() => "");
              throw new Error(
                `HTTP ${res.status} ${res.statusText}: ${text.slice(0, 500)}`,
              );
            }
            return (await res.json()) as unknown;
          },
          catch: (cause) => new ImageUpstreamFailure({ cause }),
        });
      });
    case "cf-ai-binding-image":
      return Effect.gen(function* () {
        const ai = yield* ImageAiBinding;
        const options =
          route.gatewayRef === undefined
            ? undefined
            : { gateway: { id: route.gatewayRef } };
        return yield* Effect.tryPromise({
          try: () =>
            ai.run(route.modelId, body as CfAiBindingImageBody, options),
          catch: (cause) => new ImageUpstreamFailure({ cause }),
        });
      });
  }
};

export const generateImageEffect = (
  spec: GenerateImageSpec,
): Effect.Effect<
  ImageResult,
  ImageUpstreamFailure | ImageEndpointNotFound | ImageCredentialNotFound,
  ImageAiBinding | ImageProviderRegistry
> =>
  Effect.gen(function* () {
    const adapter = getImageProtocolAdapter(spec.route.kind);
    const body = adapter.encodeImage(
      spec.route as never,
      { prompt: spec.prompt, aspectRatio: spec.aspectRatio },
    );
    const raw = yield* dispatchImageProvider(spec.route, body);
    return yield* Effect.try({
      try: () => adapter.decodeImage(raw),
      catch: (cause) => new ImageUpstreamFailure({ cause }),
    });
  });
