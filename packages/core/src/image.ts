/**
 * Image generation route adapters.
 *
 * P3 / C5 from spec-28: image generation is provider route capability, not a
 * Tool and not a submitAgent turn. Core owns finite protocol adapters and
 * provider envelope decoding; apps own artifact materialization (R2, URLs,
 * retention policy).
 */

import { Effect } from "effect";
import { UpstreamFailure } from "./errors";
import { AiBinding } from "./llm";
import {
  CredentialNotFound,
  EndpointNotFound,
  ProviderRegistry,
} from "./provider-registry";
import type { Outcome } from "./admission";

export interface OpenAIChatCompatibleImageRoute {
  readonly kind: "openai-chat-compatible-image";
  readonly endpointRef: string;
  readonly credentialRef: string;
  readonly modelId: string;
}

export interface CfAiBindingImageRoute {
  readonly kind: "cf-ai-binding-image";
  readonly modelId: string;
  readonly gatewayRef?: string;
}

export type ImageRoute =
  | OpenAIChatCompatibleImageRoute
  | CfAiBindingImageRoute;

export interface ImageRequest {
  readonly prompt: string;
  readonly aspectRatio?: string;
}

export type ImageArtifact =
  | { readonly kind: "data-url"; readonly dataUrl: string; readonly contentType?: string }
  | { readonly kind: "url"; readonly url: string; readonly contentType?: string }
  | { readonly kind: "bytes"; readonly bytes: Uint8Array; readonly contentType: string };

export interface ImageResult {
  readonly artifacts: ReadonlyArray<ImageArtifact>;
  readonly usage?: unknown;
}

export interface GenerateImageSpec extends ImageRequest {
  readonly route: ImageRoute;
}

interface OpenAIChatCompatibleImageBody {
  readonly modalities: ReadonlyArray<"text" | "image">;
  readonly messages: ReadonlyArray<{
    readonly role: "user";
    readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
  }>;
  readonly aspect_ratio?: string;
}

interface CfAiBindingImageBody {
  readonly prompt: string;
  readonly aspect_ratio?: string;
}

type ImageProviderBodyByKind = {
  readonly "openai-chat-compatible-image": OpenAIChatCompatibleImageBody;
  readonly "cf-ai-binding-image": CfAiBindingImageBody;
};

type ImageProviderBody<K extends ImageRoute["kind"]> =
  ImageProviderBodyByKind[K];

export interface ImageProtocolAdapter<K extends ImageRoute["kind"]> {
  readonly kind: K;
  readonly version: string;
  readonly encodeImage: (
    route: Extract<ImageRoute, { kind: K }>,
    request: ImageRequest,
  ) => ImageProviderBody<K>;
  readonly decodeImage: (raw: unknown) => ImageResult;
  readonly classify: (error: unknown) => Outcome;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (isRecord(error) && "cause" in error) return errorMessage(error.cause);
  return String(error);
};

const classifyHttpish = (error: unknown): Outcome => {
  const message = errorMessage(error);
  if (
    /\b401\b/.test(message) ||
    /\b403\b/.test(message) ||
    message.includes("API_KEY_INVALID") ||
    message.includes("invalid api key")
  ) {
    return { class: "AuthError", status: 401 };
  }
  if (/\b429\b/.test(message)) {
    return { class: "RateLimited" };
  }
  if (/\b400\b/.test(message)) {
    return { class: "ProviderRejected", status: 400, body: message };
  }
  return { class: "TransientError", cause: message };
};

const contentTypeFromDataUrl = (url: string): string | undefined => {
  const match = /^data:([^;,]+)[;,]/.exec(url);
  return match?.[1];
};

const artifactFromUrl = (url: string): ImageArtifact => {
  if (url.startsWith("data:")) {
    return {
      kind: "data-url",
      dataUrl: url,
      contentType: contentTypeFromDataUrl(url),
    };
  }
  return { kind: "url", url };
};

const decodeOpenAIChatCompatibleImage = (raw: unknown): ImageResult => {
  if (!isRecord(raw) || !Array.isArray(raw.choices)) {
    throw new Error("image response missing choices[]");
  }
  const artifacts: ImageArtifact[] = [];
  for (const choice of raw.choices) {
    if (!isRecord(choice) || !isRecord(choice.message)) continue;
    const images = choice.message.images;
    if (!Array.isArray(images)) continue;
    for (const image of images) {
      if (!isRecord(image) || !isRecord(image.image_url)) continue;
      const url = image.image_url.url;
      if (typeof url === "string") {
        artifacts.push(artifactFromUrl(url));
      }
    }
  }
  if (artifacts.length === 0) {
    throw new Error("image response contained no image_url artifacts");
  }
  return { artifacts, usage: raw.usage };
};

const decodeCfAiBindingImage = (raw: unknown): ImageResult => {
  if (typeof raw === "string") {
    return { artifacts: [artifactFromUrl(raw)] };
  }
  if (raw instanceof ArrayBuffer) {
    return {
      artifacts: [
        {
          kind: "bytes",
          bytes: new Uint8Array(raw),
          contentType: "application/octet-stream",
        },
      ],
    };
  }
  if (raw instanceof Uint8Array) {
    return {
      artifacts: [
        {
          kind: "bytes",
          bytes: raw,
          contentType: "application/octet-stream",
        },
      ],
    };
  }
  if (!isRecord(raw)) {
    throw new Error("cf-ai-binding-image response must be object or string");
  }
  if (typeof raw.image === "string") {
    return { artifacts: [artifactFromUrl(raw.image)], usage: raw.usage };
  }
  if (typeof raw.url === "string") {
    return { artifacts: [artifactFromUrl(raw.url)], usage: raw.usage };
  }
  if (Array.isArray(raw.images)) {
    const artifacts = raw.images.flatMap((image): ImageArtifact[] => {
      if (typeof image === "string") return [artifactFromUrl(image)];
      if (isRecord(image) && typeof image.url === "string") {
        return [artifactFromUrl(image.url)];
      }
      return [];
    });
    if (artifacts.length > 0) return { artifacts, usage: raw.usage };
  }
  throw new Error("cf-ai-binding-image response contained no image artifact");
};

export const openaiChatCompatibleImageAdapter:
  ImageProtocolAdapter<"openai-chat-compatible-image"> = {
    kind: "openai-chat-compatible-image",
    version: "1.0.0",
    encodeImage: (_route, request) => ({
      modalities: ["text", "image"],
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: request.prompt }],
        },
      ],
      ...(request.aspectRatio === undefined
        ? {}
        : { aspect_ratio: request.aspectRatio }),
    }),
    decodeImage: decodeOpenAIChatCompatibleImage,
    classify: classifyHttpish,
  };

export const cfAiBindingImageAdapter:
  ImageProtocolAdapter<"cf-ai-binding-image"> = {
    kind: "cf-ai-binding-image",
    version: "1.0.0",
    encodeImage: (_route, request) => ({
      prompt: request.prompt,
      ...(request.aspectRatio === undefined
        ? {}
        : { aspect_ratio: request.aspectRatio }),
    }),
    decodeImage: decodeCfAiBindingImage,
    classify: classifyHttpish,
  };

export type ImageProtocolAdapterRegistry = {
  readonly [K in ImageRoute["kind"]]: ImageProtocolAdapter<K>;
};

export const imageProtocolAdapters: ImageProtocolAdapterRegistry = {
  "openai-chat-compatible-image": openaiChatCompatibleImageAdapter,
  "cf-ai-binding-image": cfAiBindingImageAdapter,
};

export const getImageProtocolAdapter = <K extends ImageRoute["kind"]>(
  kind: K,
): ImageProtocolAdapter<K> => imageProtocolAdapters[kind];

const dispatchImageProvider = (
  route: ImageRoute,
  body: ImageProviderBody<ImageRoute["kind"]>,
): Effect.Effect<
  unknown,
  UpstreamFailure | EndpointNotFound | CredentialNotFound,
  AiBinding | ProviderRegistry
> => {
  switch (route.kind) {
    case "openai-chat-compatible-image":
      return Effect.gen(function* () {
        const registry = yield* ProviderRegistry;
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
          catch: (cause) => new UpstreamFailure({ cause }),
        });
      });
    case "cf-ai-binding-image":
      return Effect.gen(function* () {
        const ai = yield* AiBinding;
        const options =
          route.gatewayRef === undefined
            ? undefined
            : { gateway: { id: route.gatewayRef } };
        return yield* Effect.tryPromise({
          try: () =>
            (
              ai as {
                run: (
                  model: string,
                  input: unknown,
                  options?: unknown,
                ) => Promise<unknown>;
              }
            ).run(route.modelId, body as CfAiBindingImageBody, options),
          catch: (cause) => new UpstreamFailure({ cause }),
        });
      });
  }
};

export const generateImageEffect = (
  spec: GenerateImageSpec,
): Effect.Effect<
  ImageResult,
  UpstreamFailure | EndpointNotFound | CredentialNotFound,
  AiBinding | ProviderRegistry
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
      catch: (cause) => new UpstreamFailure({ cause }),
    });
  });
