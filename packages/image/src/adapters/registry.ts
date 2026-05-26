import { cfAiBindingImageAdapter } from "./cf-ai-binding";
import { openaiChatCompatibleImageAdapter } from "./openai-chat-compatible";
import type { ImageProtocolAdapter, ImageProtocolAdapterRegistry, ImageRoute } from "../types";

const imageProtocolAdapters: ImageProtocolAdapterRegistry = {
  "openai-chat-compatible-image": openaiChatCompatibleImageAdapter,
  "cf-ai-binding-image": cfAiBindingImageAdapter,
};

export const getImageProtocolAdapter = <K extends ImageRoute["kind"]>(
  kind: K,
): ImageProtocolAdapter<K> => imageProtocolAdapters[kind];
