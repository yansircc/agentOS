import { artifactFromUrl, classifyHttpish, isRecord } from "../shared";
import type { ImageArtifact, ImageProtocolAdapter, ImageResult } from "../types";

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
