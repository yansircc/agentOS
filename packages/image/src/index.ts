/**
 * @agent-os/image — image protocol algebra.
 *
 * This package owns image provider route encoding/decoding and image-specific
 * pure helpers. It does not own ledger writes, resource ledgers, blob storage,
 * R2 key policy, retention, public URLs, or provider fallback.
 */

import { Context, Data, Effect, Layer } from "effect";

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
  | {
      readonly kind: "data-url";
      readonly dataUrl: string;
      readonly contentType?: string;
    }
  | { readonly kind: "url"; readonly url: string; readonly contentType?: string }
  | {
      readonly kind: "bytes";
      readonly bytes: Uint8Array;
      readonly contentType: string;
    };

export interface ImageResult {
  readonly artifacts: ReadonlyArray<ImageArtifact>;
  readonly usage?: unknown;
}

export interface GenerateImageSpec extends ImageRequest {
  readonly route: ImageRoute;
}

export type ImageOutcome =
  | { readonly class: "AuthError"; readonly status: 401 | 403 }
  | { readonly class: "RateLimited" }
  | {
      readonly class: "ProviderRejected";
      readonly status?: number;
      readonly body?: unknown;
    }
  | { readonly class: "TransientError"; readonly cause: unknown };

interface OpenAIChatCompatibleImageBody {
  readonly modalities: ReadonlyArray<"text" | "image">;
  readonly messages: ReadonlyArray<{
    readonly role: "user";
    readonly content: ReadonlyArray<{
      readonly type: "text";
      readonly text: string;
    }>;
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
  readonly classify: (error: unknown) => ImageOutcome;
}

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (isRecord(error) && "cause" in error) return errorMessage(error.cause);
  return String(error);
};

const classifyHttpish = (error: unknown): ImageOutcome => {
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

const imageProtocolAdapters: ImageProtocolAdapterRegistry = {
  "openai-chat-compatible-image": openaiChatCompatibleImageAdapter,
  "cf-ai-binding-image": cfAiBindingImageAdapter,
};

const getImageProtocolAdapter = <K extends ImageRoute["kind"]>(
  kind: K,
): ImageProtocolAdapter<K> => imageProtocolAdapters[kind];

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

/**
 * Reserved substrate vocabulary. v0 has no public writer for these events:
 * passing one to AgentDOBase.emitEvent / scheduleEvent / dispatchToScope will
 * fail with ReservedEventKindError. Use these constants only for read-side
 * projection of substrate-emitted facts when a future image job writer ships.
 */
export const IMAGE_EVENTS = {
  JOB_REQUESTED: "image.job.requested",
  PROVIDER_COMPLETED: "image.provider.completed",
  ARTIFACT_MATERIALIZED: "image.artifact.materialized",
  JOB_FAILED: "image.job.failed",
  JOB_CANCELLED: "image.job.cancelled",
} as const;

export type ImageEventKind = (typeof IMAGE_EVENTS)[keyof typeof IMAGE_EVENTS];

export interface ImageLedgerEvent {
  readonly kind: string;
  readonly payload: unknown;
}

export type ImageJobStatus =
  | "requested"
  | "provider_completed"
  | "materialized"
  | "failed"
  | "cancelled";

export interface ImageJobProjection {
  readonly jobId: string;
  readonly status: ImageJobStatus;
  readonly artifacts: ReadonlyArray<unknown>;
  readonly failure?: unknown;
}

const jobIdFromPayload = (payload: unknown): string | undefined => {
  if (!isRecord(payload)) return undefined;
  return typeof payload.jobId === "string" ? payload.jobId : undefined;
};

export const projectImageJobs = (
  events: Iterable<ImageLedgerEvent>,
): ReadonlyMap<string, ImageJobProjection> => {
  const jobs = new Map<string, ImageJobProjection>();
  for (const event of events) {
    const jobId = jobIdFromPayload(event.payload);
    if (jobId === undefined) continue;
    const current = jobs.get(jobId) ?? {
      jobId,
      status: "requested" as ImageJobStatus,
      artifacts: [],
    };
    switch (event.kind) {
      case IMAGE_EVENTS.JOB_REQUESTED:
        jobs.set(jobId, { ...current, status: "requested" });
        break;
      case IMAGE_EVENTS.PROVIDER_COMPLETED:
        jobs.set(jobId, { ...current, status: "provider_completed" });
        break;
      case IMAGE_EVENTS.ARTIFACT_MATERIALIZED: {
        const artifacts = isRecord(event.payload) && "artifactRef" in event.payload
          ? [...current.artifacts, event.payload.artifactRef]
          : current.artifacts;
        jobs.set(jobId, { ...current, status: "materialized", artifacts });
        break;
      }
      case IMAGE_EVENTS.JOB_FAILED:
        jobs.set(jobId, {
          ...current,
          status: "failed",
          failure: isRecord(event.payload) ? event.payload.failure : undefined,
        });
        break;
      case IMAGE_EVENTS.JOB_CANCELLED:
        jobs.set(jobId, { ...current, status: "cancelled" });
        break;
    }
  }
  return jobs;
};

type StableJson =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<StableJson>
  | { readonly [key: string]: StableJson | undefined };

const stableStringify = (value: StableJson): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value)
    .filter((entry): entry is [string, StableJson] => entry[1] !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
    .join(",")}}`;
};

const fnv1a64 = (text: string): string => {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * prime);
  }
  return hash.toString(16).padStart(16, "0");
};

export interface ImageJobIdentity {
  readonly sourceScope: string;
  readonly intentId: string;
  readonly route: ImageRoute;
  readonly prompt: string;
  readonly aspectRatio?: string;
  readonly seed?: string | number;
}

export const imageJobIdempotencyKey = (
  identity: ImageJobIdentity,
): string =>
  `image.job.${fnv1a64(stableStringify(identity as unknown as StableJson))}`;

export const withImageResourceSettlement = <A, E, R, CE, CR, RE, RR>(
  effect: Effect.Effect<A, E, R>,
  settlement: {
    readonly consume: (value: A) => Effect.Effect<void, CE, CR>;
    readonly release: (error: E) => Effect.Effect<void, RE, RR>;
  },
): Effect.Effect<A, E | CE | RE, R | CR | RR> =>
  Effect.matchEffect(effect, {
    onFailure: (error) =>
      settlement.release(error).pipe(Effect.zipRight(Effect.fail(error))),
    onSuccess: (value) =>
      settlement.consume(value).pipe(Effect.as(value)),
  });
