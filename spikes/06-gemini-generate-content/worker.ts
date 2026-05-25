/**
 * agent-OS spike-06 — gemini-generate-content adapter on a live wire.
 *
 * Falsification surface mirrors spike-05's (anthropic):
 *
 *   A1  routeFingerprint isolation — gemini-generate-content is a
 *       distinct capability surface from cf-ai-binding / openai-chat-
 *       compatible / anthropic-messages, even if a model with similar
 *       name existed on multiple.
 *   A2  multi-turn tool loop with `counter` tool against
 *       gemini-3.1-flash-lite.
 *   A3  structured submit producing schema-conforming JSON.
 *   A4  evidence.adapterId reads `gemini-generate-content@1.0.0`.
 *   A5  classify on real 401 (bogus api key) → AuthError.
 *   A6  forced-tool-call reliability (5 runs).
 *   A7  no aggregator masquerade — the body posted is Gemini-native
 *       (`v1beta/models/${modelId}:generateContent`, `x-goog-api-key`,
 *       systemInstruction, tools[].functionDeclarations,
 *       toolConfig.functionCallingConfig.mode="ANY"). Successful
 *       Supported = the endpoint actually speaks Gemini wire.
 *
 * Routes:
 *   POST /turn          run a free-text agent loop with the counter tool
 *   POST /structured    run submit({outputSchema}) for a summary schema
 *   POST /test/classify-401  trigger and classify a 401 via bogus key
 *   GET  /events        dump ledger
 */

import {
  AgentDOBase,
  type AgentDOEnv,
  type JsonSchemaObject,
  type LlmRoute,
  type ProviderRegistryConfig,
  type Tool,
} from "@agent-os/core";

interface Env extends AgentDOEnv {
  readonly GEMINI_KEY: string;
  readonly SPIKE_DO: DurableObjectNamespace<SpikeAgentDO>;
}

const ROUTE_GEMINI: LlmRoute = {
  kind: "gemini-generate-content",
  endpointRef: "google",
  credentialRef: "GEMINI_KEY",
  modelId: "gemini-3.1-flash-lite",
};

const ROUTE_BAD_AUTH: LlmRoute = {
  kind: "gemini-generate-content",
  endpointRef: "google",
  credentialRef: "BOGUS_KEY",
  modelId: "gemini-3.1-flash-lite",
};

const counterTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "counter",
      description:
        "Return the count of a substring within a string. Use this tool when the user asks how many times something appears.",
      parameters: {
        type: "object",
        properties: {
          haystack: { type: "string", description: "the string to search in" },
          needle: { type: "string", description: "the substring to count" },
        },
        required: ["haystack", "needle"],
      },
    },
  },
  execute: async (raw: unknown) => {
    const args = raw as { haystack?: string; needle?: string };
    if (typeof args.haystack !== "string" || typeof args.needle !== "string") {
      return { error: "invalid args" };
    }
    if (args.needle.length === 0) return { count: 0 };
    let n = 0;
    let i = 0;
    while ((i = args.haystack.indexOf(args.needle, i)) !== -1) {
      n++;
      i += args.needle.length;
    }
    return { haystack: args.haystack, needle: args.needle, count: n };
  },
};

const SUMMARY_SCHEMA: JsonSchemaObject = {
  type: "object",
  properties: {
    summary: { type: "string" },
    sentiment: {
      type: "string",
      enum: ["positive", "negative", "neutral"],
    },
    keywords: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "sentiment", "keywords"],
  additionalProperties: false,
};

export class SpikeAgentDO extends AgentDOBase<Env> {
  protected override provideRegistry(): ProviderRegistryConfig {
    return {
      endpoints: {
        google: "https://generativelanguage.googleapis.com",
      },
      credentials: {
        GEMINI_KEY: this.env.GEMINI_KEY,
        BOGUS_KEY: "AIza-bogus-key-for-401-test",
      },
    };
  }
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const sessionId = url.searchParams.get("session") ?? "default";
    const id = env.SPIKE_DO.idFromName(sessionId);
    const stub = env.SPIKE_DO.get(id);

    if (url.pathname === "/turn" && req.method === "POST") {
      const body = (await req.json()) as { prompt?: string };
      const prompt =
        body.prompt ??
        "How many times does 'ana' appear in 'banana cabana ananas'? Use the counter tool.";
      const result = await stub.submit({
        intent: prompt,
        context: {},
        route: ROUTE_GEMINI,
        tools: { counter: counterTool },
        budget: { tokens: 8000, maxTurns: 4 },
        deliver: { event: "turn.delivered" },
      });
      return json({ ok: true, kind: "turn", result });
    }

    if (url.pathname === "/structured" && req.method === "POST") {
      const body = (await req.json()) as { text?: string };
      const text =
        body.text ??
        "I tried the new pasta restaurant downtown last night. The sauce was rich and the staff was friendly, though the wait was long.";
      const result = await stub.submit({
        intent: `Summarize this review:\n${text}`,
        context: {},
        route: ROUTE_GEMINI,
        tools: {},
        outputSchema: SUMMARY_SCHEMA,
        budget: { tokens: 4000 },
        deliver: { event: "summary.delivered" },
      });
      return json({ ok: true, kind: "structured", result });
    }

    if (url.pathname === "/test/classify-401" && req.method === "POST") {
      const result = await stub
        .submit({
          intent: "this call should 401 because credential is bogus",
          context: {},
          route: ROUTE_BAD_AUTH,
          tools: {},
          outputSchema: SUMMARY_SCHEMA,
          budget: { tokens: 1000 },
          deliver: { event: "summary.delivered" },
        })
        .catch((e: unknown) => ({ rejected: true, cause: String(e) }));
      return json({ ok: true, kind: "classify-401", result });
    }

    if (url.pathname === "/events" && req.method === "GET") {
      const events = await stub.events();
      return json({ ok: true, count: events.length, events });
    }

    if (url.pathname === "/" || url.pathname === "/help") {
      return json({
        ok: true,
        routes: [
          "POST /turn?session=...",
          "POST /structured?session=...",
          "POST /test/classify-401?session=...",
          "GET  /events?session=...",
        ],
      });
    }

    return json({ ok: false, reason: "not found", path: url.pathname }, 404);
  },
} satisfies ExportedHandler<Env>;
