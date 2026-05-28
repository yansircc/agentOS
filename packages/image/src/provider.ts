import { Effect } from "effect";
import {
  RefResolutionFailed,
  RefResolverService,
  resolveStringMaterial,
} from "@agent-os/kernel/ref-resolver";
import { credentialMaterialRef, endpointMaterialRef } from "@agent-os/kernel/material-ref";
import { getImageProtocolAdapter } from "./adapters/registry";
import { ImageAiBinding, ImageDecodeFailure, ImageUpstreamFailure } from "./services";
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
  ImageUpstreamFailure | RefResolutionFailed,
  ImageAiBinding | RefResolverService
> => {
  switch (route.kind) {
    case "openai-chat-compatible-image":
      return Effect.gen(function* () {
        const refs = yield* RefResolverService;
        const endpoint = yield* resolveStringMaterial(
          refs,
          endpointMaterialRef(route.endpointRef, { protocol: route.kind }),
        );
        const apiKey = yield* resolveStringMaterial(
          refs,
          credentialMaterialRef(route.credentialRef, {
            provider: route.kind,
            purpose: "image_transport",
          }),
        );
        const url = `${endpoint.replace(/\/$/, "")}/chat/completions`;
        const fullBody = {
          model: route.modelId,
          ...(body as OpenAIChatCompatibleImageBody),
        };
        const res = yield* Effect.tryPromise({
          try: () =>
            fetch(url, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(fullBody),
            }),
          catch: (cause) => new ImageUpstreamFailure({ cause }),
        });
        if (!res.ok) {
          return yield* Effect.fail(
            new ImageUpstreamFailure({
              cause: { status: res.status, statusText: res.statusText },
            }),
          );
        }
        return yield* Effect.tryPromise({
          try: () => res.json() as Promise<unknown>,
          catch: (cause) => new ImageUpstreamFailure({ cause }),
        });
      });
    case "cf-ai-binding-image":
      return Effect.gen(function* () {
        const ai = yield* ImageAiBinding;
        const options =
          route.gatewayRef === undefined ? undefined : { gateway: { id: route.gatewayRef } };
        return yield* Effect.tryPromise({
          try: () => ai.run(route.modelId, body as CfAiBindingImageBody, options),
          catch: (cause) => new ImageUpstreamFailure({ cause }),
        });
      });
  }
};

export const generateImageEffect = (
  spec: GenerateImageSpec,
): Effect.Effect<
  ImageResult,
  ImageUpstreamFailure | ImageDecodeFailure | RefResolutionFailed,
  ImageAiBinding | RefResolverService
> =>
  Effect.gen(function* () {
    const adapter = getImageProtocolAdapter(spec.route.kind);
    const body = adapter.encodeImage(spec.route as never, {
      prompt: spec.prompt,
      aspectRatio: spec.aspectRatio,
    });
    const raw = yield* dispatchImageProvider(spec.route, body);
    return yield* adapter.decodeImage(raw);
  });
