/**
 * Image route adapters — deterministic contract tests.
 *
 * Validates P3 / C5 from spec-28 without touching real providers.
 */

import { Layer, ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";

import { AiBinding } from "../src/llm";
import { ProviderRegistryLive } from "../src/provider-registry";
import {
  cfAiBindingImageAdapter,
  generateImageEffect,
  openaiChatCompatibleImageAdapter,
} from "../src/image";

const SENTINEL_AI: Ai = {
  run: (() => {
    throw new Error("SENTINEL_AI: openai image route must not touch AiBinding");
  }) as Ai["run"],
} as Ai;

const runtimeFor = (
  ai: Ai,
  endpoints: Record<string, string>,
  credentials: Record<string, string>,
) =>
  ManagedRuntime.make(
    Layer.mergeAll(
      Layer.succeed(AiBinding, ai),
      ProviderRegistryLive({ endpoints, credentials }),
    ),
  );

describe("image route adapters — P3 C5", () => {
  it("openai-chat-compatible-image uses endpoint + credential refs and decodes message.images data URL", async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                images: [
                  {
                    type: "image_url",
                    image_url: {
                      url: "data:image/png;base64,AAAA",
                    },
                  },
                ],
              },
            },
          ],
          usage: { image_tokens: 12 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof globalThis.fetch;

    try {
      const runtime = runtimeFor(
        SENTINEL_AI,
        { openrouter: "https://stub.openrouter.test/api/v1" },
        { OPENROUTER_KEY: "secret-not-in-result" },
      );
      const result = await runtime.runPromise(
        generateImageEffect({
          route: {
            kind: "openai-chat-compatible-image",
            endpointRef: "openrouter",
            credentialRef: "OPENROUTER_KEY",
            modelId: "google/gemini-2.5-flash-image",
          },
          prompt: "rainy neon street",
          aspectRatio: "16:9",
        }),
      );

      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe(
        "https://stub.openrouter.test/api/v1/chat/completions",
      );
      const headers = calls[0]?.init.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer secret-not-in-result");
      const body = JSON.parse(String(calls[0]?.init.body)) as {
        readonly model?: string;
        readonly modalities?: ReadonlyArray<string>;
        readonly aspect_ratio?: string;
      };
      expect(body.model).toBe("google/gemini-2.5-flash-image");
      expect(body.modalities).toEqual(["text", "image"]);
      expect(body.aspect_ratio).toBe("16:9");

      expect(result.artifacts).toEqual([
        {
          kind: "data-url",
          dataUrl: "data:image/png;base64,AAAA",
          contentType: "image/png",
        },
      ]);
      expect(JSON.stringify(result)).not.toContain("secret-not-in-result");
      await runtime.dispose();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("cf-ai-binding-image uses env.AI.run, passes gatewayRef, and decodes provider image URI", async () => {
    const calls: Array<{
      readonly model: string;
      readonly input: unknown;
      readonly options: unknown;
    }> = [];
    const ai = {
      run: ((model: string, input: unknown, options?: unknown) => {
        calls.push({ model, input, options });
        return Promise.resolve({
          image: "https://imagedelivery.example/nano-banana.png",
          usage: { image_tokens: 99 },
        });
      }) as Ai["run"],
    } as Ai;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("SENTINEL_FETCH: cf-ai-binding-image must not fetch");
    }) as typeof globalThis.fetch;

    try {
      const runtime = runtimeFor(ai, {}, {});
      const result = await runtime.runPromise(
        generateImageEffect({
          route: {
            kind: "cf-ai-binding-image",
            modelId: "google/nano-banana",
            gatewayRef: "default",
          },
          prompt: "cozy coffee shop",
          aspectRatio: "16:9",
        }),
      );

      expect(calls).toHaveLength(1);
      expect(calls[0]?.model).toBe("google/nano-banana");
      expect(calls[0]?.input).toEqual({
        prompt: "cozy coffee shop",
        aspect_ratio: "16:9",
      });
      expect(calls[0]?.options).toEqual({ gateway: { id: "default" } });
      expect(result.artifacts).toEqual([
        {
          kind: "url",
          url: "https://imagedelivery.example/nano-banana.png",
        },
      ]);
      await runtime.dispose();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("classifies image auth failures as AuthError", () => {
    expect(
      openaiChatCompatibleImageAdapter.classify(
        new Error("HTTP 401 Unauthorized: invalid api key"),
      ),
    ).toEqual({ class: "AuthError", status: 401 });
    expect(
      cfAiBindingImageAdapter.classify(
        new Error("HTTP 400 Bad Request: API_KEY_INVALID"),
      ),
    ).toEqual({ class: "AuthError", status: 401 });
  });

  it("decodes data URL, URL, and binary provider artifacts", () => {
    expect(
      openaiChatCompatibleImageAdapter.decodeImage({
        choices: [
          {
            message: {
              images: [
                { image_url: { url: "data:image/webp;base64,BBBB" } },
                { image_url: { url: "https://cdn.example/image.png" } },
              ],
            },
          },
        ],
      }).artifacts,
    ).toEqual([
      {
        kind: "data-url",
        dataUrl: "data:image/webp;base64,BBBB",
        contentType: "image/webp",
      },
      { kind: "url", url: "https://cdn.example/image.png" },
    ]);

    const bytes = new Uint8Array([1, 2, 3]);
    expect(cfAiBindingImageAdapter.decodeImage(bytes).artifacts).toEqual([
      {
        kind: "bytes",
        bytes,
        contentType: "application/octet-stream",
      },
    ]);
  });
});
