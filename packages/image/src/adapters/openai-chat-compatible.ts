import { artifactFromUrl, classifyHttpish, isRecord } from "../shared";
import type { ImageArtifact, ImageProtocolAdapter, ImageResult } from "../types";

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

export const openaiChatCompatibleImageAdapter: ImageProtocolAdapter<"openai-chat-compatible-image"> =
  {
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
      ...(request.aspectRatio === undefined ? {} : { aspect_ratio: request.aspectRatio }),
    }),
    decodeImage: decodeOpenAIChatCompatibleImage,
    classify: classifyHttpish,
  };
