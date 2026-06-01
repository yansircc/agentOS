import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";

import { makeFacadeSubmitChatResponse, type FacadeSubmitTestDO } from "./test-worker";

interface TestEnv {
  readonly FACADE_SUBMIT_DO: DurableObjectNamespace<FacadeSubmitTestDO>;
}

const testEnv = env as unknown as TestEnv;

const requestUrl = (input: RequestInfo | URL): string =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

describe("defineAgentDO facade submit", () => {
  it("uses llms.default and configured tools from the facade config", async () => {
    const scope = "facade-submit-defaults";
    const stub = testEnv.FACADE_SUBMIT_DO.get(testEnv.FACADE_SUBMIT_DO.idFromName(scope));
    const fetchCalls: Array<{
      readonly url: string;
      readonly init: RequestInit;
    }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ url: requestUrl(input), init: init ?? {} });
      return makeFacadeSubmitChatResponse();
    }) as typeof globalThis.fetch;

    try {
      const result = await runInDurableObject(stub, (instance) =>
        instance.submit({
          intent: "lookup",
          input: { key: "abc" },
          deliver: "test.delivered",
          budget: { maxTurns: 1 },
        }),
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.final).toBe("facade done");
        expect(result.tokensUsed).toBe(7);
      }
      expect(fetchCalls).toHaveLength(1);
      const call = fetchCalls[0];
      expect(call).toBeDefined();
      if (call === undefined) return;
      expect(call.url).toBe("https://stub.openai.test/v1/chat/completions");
      expect((call.init.headers as Record<string, string>).Authorization).toBe("Bearer stub-key");
      expect(typeof call.init.body).toBe("string");
      if (typeof call.init.body !== "string") return;
      const body = JSON.parse(call.init.body) as {
        readonly model?: unknown;
        readonly tools?: ReadonlyArray<{ readonly function?: { readonly name?: unknown } }>;
      };
      expect(body.model).toBe("gpt-4.1-mini");
      expect(body.tools?.map((tool) => tool.function?.name)).toEqual(["lookup"]);

      const events = await (
        stub as {
          readonly events: () => Promise<
            ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>
          >;
        }
      ).events();
      const delivered = events.filter((event) => event.kind === "test.delivered");
      expect(delivered).toHaveLength(1);
      expect(delivered[0]?.payload).toEqual({
        final: "facade done",
        turn: { id: 1, index: 0 },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
