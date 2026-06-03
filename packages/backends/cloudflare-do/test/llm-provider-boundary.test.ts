import { Effect } from "effect";
import { describe, expect, it } from "@effect/vitest";

import { UpstreamFailure } from "@agent-os/kernel/errors";
import { RefResolverLive } from "@agent-os/kernel/ref-resolver";
import { AiBinding, dispatchProvider } from "../src/llm";

const providerRoute = {
  kind: "openai-chat-compatible",
  endpointRef: "openrouter",
  credentialRef: "openrouter-key",
  modelId: "test-model",
} as const;

const providerResolver = RefResolverLive({
  material: (ref) => {
    if (ref.kind === "endpoint" && ref.ref === "openrouter") {
      return "https://provider.example/accounts/acct-123";
    }
    if (ref.kind === "credential" && ref.ref === "openrouter-key") {
      return "sk-or-secret";
    }
    return null;
  },
});

const aiBinding = { run: () => Promise.resolve({}) } as unknown as Ai;

describe("LLM provider boundary", () => {
  it.effect("passes AbortSignal to HTTP provider fetch", () =>
    Effect.gen(function* () {
      const originalFetch = globalThis.fetch;
      const controller = new AbortController();
      let seenSignal: AbortSignal | undefined;

      globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
        seenSignal = init?.signal ?? undefined;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ ok: true }),
        } as Response);
      }) as typeof fetch;

      try {
        const raw = yield* dispatchProvider(
          providerRoute,
          { messages: [] },
          { signal: controller.signal },
        ).pipe(Effect.provideService(AiBinding, aiBinding), Effect.provide(providerResolver));

        expect(raw).toEqual({ ok: true });
        expect(seenSignal).toBe(controller.signal);
      } finally {
        globalThis.fetch = originalFetch;
      }
    }),
  );

  it.effect("sanitizes fetch rejection causes before they cross the provider boundary", () =>
    Effect.gen(function* () {
      const originalFetch = globalThis.fetch;

      globalThis.fetch = (() =>
        Promise.reject(
          new Error(
            "Abort fetching https://provider.example/accounts/acct-123/chat/completions with token sk-or-secret",
          ),
        )) as typeof fetch;

      try {
        const result = yield* Effect.either(
          dispatchProvider(providerRoute, { messages: [] }).pipe(
            Effect.provideService(AiBinding, aiBinding),
            Effect.provide(providerResolver),
          ),
        );

        expect(result._tag).toBe("Left");
        if (result._tag === "Left") {
          expect(result.left).toBeInstanceOf(UpstreamFailure);
          const serialized = JSON.stringify(result.left);
          expect(serialized).toContain("agent_os.provider_http_failure");
          expect(serialized).not.toContain("https://provider.example");
          expect(serialized).not.toContain("acct-123");
          expect(serialized).not.toContain("sk-or-secret");
          expect(serialized).not.toContain("chat/completions");
        }
      } finally {
        globalThis.fetch = originalFetch;
      }
    }),
  );
});
