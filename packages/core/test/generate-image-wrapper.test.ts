/**
 * AgentDOBase.generateImage stays a core Promise surface while image protocol
 * algebra lives in @agent-os/image.
 */

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import type { ImageResult } from "../src";
import type { TextStreamTestDO } from "./test-worker";

interface TestEnv {
  readonly TEXT_STREAM_DO: DurableObjectNamespace<TextStreamTestDO>;
}

const testEnv = env as unknown as TestEnv;

describe("AgentDOBase.generateImage wrapper", () => {
  it("delegates to @agent-os/image without writing ledger rows", async () => {
    const scope = "generate-image-wrapper-1";
    const stub = testEnv.TEXT_STREAM_DO.get(
      testEnv.TEXT_STREAM_DO.idFromName(scope),
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                images: [
                  {
                    image_url: { url: "data:image/png;base64,AAAA" },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof globalThis.fetch;

    try {
      await runInDurableObject(stub, async (instance) => {
        const result: ImageResult = await instance.generateImage({
          route: {
            kind: "openai-chat-compatible-image",
            endpointRef: "openai-text-stream-endpoint",
            credentialRef: "TEXT_STREAM_KEY",
            modelId: "image-model",
          },
          prompt: "rainy neon street",
        });

        expect(result.artifacts).toEqual([
          {
            kind: "data-url",
            dataUrl: "data:image/png;base64,AAAA",
            contentType: "image/png",
          },
        ]);
        expect(await instance.events()).toHaveLength(0);
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
