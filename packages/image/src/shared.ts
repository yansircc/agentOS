import type { ImageArtifact, ImageOutcome } from "./types";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (isRecord(error) && "cause" in error) return errorMessage(error.cause);
  return String(error);
};

export const classifyHttpish = (error: unknown): ImageOutcome => {
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

export const artifactFromUrl = (url: string): ImageArtifact => {
  if (url.startsWith("data:")) {
    return {
      kind: "data-url",
      dataUrl: url,
      contentType: contentTypeFromDataUrl(url),
    };
  }
  return { kind: "url", url };
};
