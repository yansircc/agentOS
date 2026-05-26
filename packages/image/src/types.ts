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

export interface OpenAIChatCompatibleImageBody {
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

export interface CfAiBindingImageBody {
  readonly prompt: string;
  readonly aspect_ratio?: string;
}

export type ImageProviderBodyByKind = {
  readonly "openai-chat-compatible-image": OpenAIChatCompatibleImageBody;
  readonly "cf-ai-binding-image": CfAiBindingImageBody;
};

export type ImageProviderBody<K extends ImageRoute["kind"]> =
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

export type ImageProtocolAdapterRegistry = {
  readonly [K in ImageRoute["kind"]]: ImageProtocolAdapter<K>;
};
