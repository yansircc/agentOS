import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";

import { credentialMaterialRef } from "@agent-os/kernel/material-ref";
import { defineAgentSubmitBindings } from "@agent-os/runtime-protocol";
import {
  facadeApply,
  facadeLookup,
  makeFacadeSubmitChatResponse,
  type FacadeSubmitTestDO,
} from "./test-worker";
import { testTruthIdentity } from "./_identity";

interface TestEnv {
  readonly FACADE_SUBMIT_DO: DurableObjectNamespace<FacadeSubmitTestDO>;
}

const testEnv = env as unknown as TestEnv;

const requestUrl = (input: RequestInfo | URL): string =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

const headerValue = (headers: HeadersInit | undefined, name: string): string | null => {
  if (headers === undefined) return null;
  if (headers instanceof Headers) return headers.get(name);
  if (Array.isArray(headers)) {
    return headers.find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] ?? null;
  }
  if (Symbol.iterator in headers) {
    for (const entry of headers) {
      const [key, value] = Array.from(entry);
      if (key?.toLowerCase() === name.toLowerCase()) return value ?? null;
    }
    return null;
  }
  const record = headers as Record<string, string>;
  return record[name] ?? record[name.toLowerCase()] ?? null;
};

const requestBodyText = async (
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<string | null> => {
  if (typeof init?.body === "string") return init.body;
  if (init?.body instanceof Uint8Array) return new TextDecoder().decode(init.body);
  if (init?.body instanceof ReadableStream) {
    const reader = init.body.getReader();
    const decoder = new TextDecoder();
    let out = "";
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      out += decoder.decode(next.value, { stream: true });
    }
    return out + decoder.decode();
  }
  if (input instanceof Request) return input.clone().text();
  return null;
};

const makeFacadeSubmitToolCallResponse = (): Response =>
  Response.json({
    id: "chatcmpl_facade_submit_tool_call",
    object: "chat.completion",
    model: "gpt-4.1-mini",
    created: 1_700_000_000,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-apply",
              type: "function",
              function: {
                name: "apply",
                arguments: '{"key":"abc"}',
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: {
      prompt_tokens: 3,
      completion_tokens: 2,
      total_tokens: 5,
    },
  });

describe("defineAgentDO facade submit", () => {
  it("uses llms.default and run-scoped tools from submit bindings", async () => {
    const scope = "facade-submit-defaults";
    const stub = testEnv.FACADE_SUBMIT_DO.get(testEnv.FACADE_SUBMIT_DO.idFromName(scope));
    const fetchCalls: Array<{
      readonly url: string;
      readonly init: RequestInit;
      readonly bodyText: string | null;
    }> = [];
    const originalFetch = globalThis.fetch;
    const effectAuthorityRef = {
      authorityClass: "llm_route" as const,
      authorityId: "facade-submit-test",
    };
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({
        url: requestUrl(input),
        init: init ?? {},
        bodyText: await requestBodyText(input, init),
      });
      return makeFacadeSubmitChatResponse();
    }) as typeof globalThis.fetch;

    try {
      const result = await runInDurableObject(stub, (instance) =>
        instance.submit({
          intent: "lookup",
          input: { key: "abc" },
          effectAuthorityRef,
          bindings: defineAgentSubmitBindings({
            handlers: {},
            tools: { lookup: facadeLookup },
          }),
          budget: { maxTurns: 1 },
        }),
      );

      const events = await (
        stub as unknown as {
          readonly events: (
            identity: ReturnType<typeof testTruthIdentity>,
          ) => Promise<ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>>;
        }
      ).events(testTruthIdentity(scope, effectAuthorityRef));

      expect(result.ok, JSON.stringify({ result, events })).toBe(true);
      if (result.ok) {
        expect(result.final).toBe("facade done");
        expect(result.tokensUsed).toBe(7);
      }
      expect(fetchCalls).toHaveLength(1);
      const call = fetchCalls[0];
      expect(call).toBeDefined();
      if (call === undefined) return;
      expect(call.url).toBe("https://stub.openai.test/v1/chat/completions");
      expect(headerValue(call.init.headers, "authorization")).toBe("Bearer stub-key");
      expect(typeof call.bodyText).toBe("string");
      if (call.bodyText === null) return;
      const body = JSON.parse(call.bodyText) as {
        readonly model?: unknown;
        readonly tools?: ReadonlyArray<{
          readonly type?: unknown;
          readonly function?: { readonly name?: unknown };
        }>;
      };
      expect(body.model).toBe("gpt-4.1-mini");
      expect(body.tools?.map((tool) => tool.function?.name)).toEqual(["lookup"]);
      expect(body.tools?.map((tool) => tool.type)).toEqual(["function"]);

      const completed = events.filter((event) => event.kind === "agent.run.completed");
      expect(completed).toHaveLength(1);
      expect(completed[0]?.payload).toEqual({
        runId: 1,
        final: "facade done",
        output: "facade done",
        outputKind: "text",
        tokensUsed: 7,
        turn: { id: 1, index: 0 },
      });
      expect(events.some((event) => event.kind === "test.delivered")).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("passes run-scoped material refs through submit bindings into runtime resolution", async () => {
    const scope = "facade-submit-material-bindings";
    const stub = testEnv.FACADE_SUBMIT_DO.get(testEnv.FACADE_SUBMIT_DO.idFromName(scope));
    const fetchCalls: Array<{
      readonly url: string;
      readonly init: RequestInit;
      readonly bodyText: string | null;
    }> = [];
    const originalFetch = globalThis.fetch;
    const effectAuthorityRef = {
      authorityClass: "llm_route" as const,
      authorityId: "facade-submit-material-test",
    };
    const tokenRef = credentialMaterialRef("facade-token", {
      provider: "facade",
      purpose: "apply",
    });
    let fetchCount = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCount += 1;
      fetchCalls.push({
        url: requestUrl(input),
        init: init ?? {},
        bodyText: await requestBodyText(input, init),
      });
      return fetchCount === 1 ? makeFacadeSubmitToolCallResponse() : makeFacadeSubmitChatResponse();
    }) as typeof globalThis.fetch;

    try {
      const result = await runInDurableObject(stub, (instance) =>
        instance.submit({
          intent: "apply",
          input: { key: "abc" },
          effectAuthorityRef,
          bindings: defineAgentSubmitBindings({
            handlers: {},
            tools: { apply: facadeApply },
            materials: { facade_token: tokenRef },
          }),
          budget: { maxTurns: 2 },
        }),
      );

      const events = await (
        stub as unknown as {
          readonly events: (
            identity: ReturnType<typeof testTruthIdentity>,
          ) => Promise<ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>>;
        }
      ).events(testTruthIdentity(scope, effectAuthorityRef));

      expect(result.ok, JSON.stringify({ result, events })).toBe(true);
      expect(fetchCalls).toHaveLength(2);
      expect(fetchCalls[1]?.bodyText).toContain('"materialMatched":true');
      expect(JSON.stringify(fetchCalls)).not.toContain(
        "facade-secret-that-must-stay-out-of-ledger-and-llm-requests",
      );
      expect(JSON.stringify(events)).not.toContain(
        "facade-secret-that-must-stay-out-of-ledger-and-llm-requests",
      );
      expect(events.some((event) => event.kind === "tool.executed")).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
