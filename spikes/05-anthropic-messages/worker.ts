/**
 * agent-OS spike-05 — anthropic-messages adapter on a live wire.
 *
 * Falsification surface (algebra-level claims about the anthropic adapter
 * implemented in packages/core/src/protocol-adapter.ts §E.2):
 *
 *   A1  routeFingerprint isolation
 *       Different `kind` for same modelId → different fingerprint.
 *       Anthropic-via-aihubmix evidence cannot be merged with OpenAI-shape
 *       evidence at the lease projection level (spec-27 §1 C-3).
 *
 *   A2  end-to-end turn loop
 *       `/turn` runs a multi-turn agent loop with a `counter` tool against
 *       claude-sonnet-4-6 on aihubmix. Verifies encodeTurn produces a body
 *       claude accepts, decodeTurn correctly folds tool_use blocks back
 *       into the unified LlmResponse shape, and submit-agent.ts's tool
 *       loop progresses without protocol-specific branches.
 *
 *   A3  end-to-end structured submit
 *       `/structured` runs `submit({outputSchema})` against the same
 *       wire. Verifies attemptStructured succeeds (Supported outcome),
 *       deliver event carries the decoded payload, evidence row's
 *       adapterId reads `anthropic-messages@1.0.0`.
 *
 *   A4  adapterId truth
 *       After /turn and /structured, the ledger contains an
 *       `llm.structured.evidence` row whose payload.adapterId is
 *       `anthropic-messages@1.0.0`. If a wire other than Anthropic served
 *       the call, adapterId would expose the mismatch.
 *
 *   A5  classify on real 401
 *       `/test/classify-401` hits aihubmix with a bogus credential and
 *       expects evidence outcome.class = "AuthError" (NOT ProviderRejected).
 *       Tests that classifyAnthropicError correctly parses
 *       `HTTP 401 ...` produced by dispatchProvider.
 *
 *   A6  forced-tool-call reliability
 *       `/structured` run N times. spike-04 observed gpt-oss-120b
 *       ≈60% Supported (3/3) and ≈40% partial. We report the observed
 *       Supported rate for claude-sonnet-4-6 here without making a claim
 *       — this is data, not a contract.
 *
 *   A7  no aggregator masquerade
 *       The wire is anthropic-messages over aihubmix. The body posted is
 *       Anthropic Messages format (`/v1/messages`, `x-api-key`,
 *       top-level `system`, `tool_choice: {type:"tool", name}`). If
 *       aihubmix translated through OpenAI shape, the upstream would
 *       reject our body. Successful Supported = aihubmix actually
 *       speaks Anthropic protocol.
 *
 * Routes:
 *   POST /turn          run a free-text agent loop with the counter tool
 *   POST /structured    run submit({outputSchema}) for a summary schema
 *   POST /test/classify-401  trigger and classify a 401 from aihubmix
 *   GET  /events        dump ledger
 *   POST /reset         wipe DO state
 *
 * Secrets:
 *   .dev.vars holds ANTHROPIC_KEY_AIHUBMIX. Never committed.
 */

import {
  AgentDOBase,
  type AgentDOEnv,
  type JsonSchemaObject,
  type LedgerEventRpc,
  type LlmRoute,
  type ProviderRegistryConfig,
  type Tool,
} from "@agent-os/core";

interface Env extends AgentDOEnv {
  readonly ANTHROPIC_KEY_AIHUBMIX: string;
  readonly SPIKE_DO: DurableObjectNamespace<SpikeAgentDO>;
}

// ============================================================
// Routes used by spike — anthropic-messages over aihubmix
// ============================================================

const ROUTE_ANTHROPIC: LlmRoute = {
  kind: "anthropic-messages",
  endpointRef: "aihubmix",
  credentialRef: "ANTHROPIC_KEY_AIHUBMIX",
  modelId: "claude-sonnet-4-6",
};

const ROUTE_BAD_AUTH: LlmRoute = {
  kind: "anthropic-messages",
  endpointRef: "aihubmix",
  credentialRef: "BOGUS_KEY", // resolved at provideRegistry() — we inject a known-bad value
  modelId: "claude-sonnet-4-6",
};

// ============================================================
// Tool used by /turn — pure local computation, no external IO
// ============================================================

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

// ============================================================
// Output schema for /structured — small, closed object
// ============================================================

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

// ============================================================
// SpikeAgentDO — extends AgentDOBase, wires the provideRegistry
// to aihubmix and exposes turn / structured / classify-401 routes.
// ============================================================

export class SpikeAgentDO extends AgentDOBase<Env> {
  protected override provideRegistry(): ProviderRegistryConfig {
    return {
      endpoints: {
        aihubmix: "https://aihubmix.com",
      },
      credentials: {
        ANTHROPIC_KEY_AIHUBMIX: this.env.ANTHROPIC_KEY_AIHUBMIX,
        BOGUS_KEY: "sk-bogus-key-for-401-test",
      },
    };
  }
}

// ============================================================
// Worker — dispatches HTTP to the SpikeAgentDO instance
// ============================================================

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
        route: ROUTE_ANTHROPIC,
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
        route: ROUTE_ANTHROPIC,
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

    if (url.pathname === "/reset" && req.method === "POST") {
      // No public reset on AgentDOBase — for spike, we just request a new
      // DO instance by changing the session name. Document that test.sh
      // uses `?session=run-<timestamp>` for isolation.
      return json({
        ok: true,
        note: "Use ?session=<unique-name> to isolate runs. There is no in-place wipe primitive in the substrate.",
      });
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

// Defensive: prove unused import LedgerEventRpc is intentional — the type
// is exported for downstream tooling reading the spike's /events response.
export type SpikeEvent = LedgerEventRpc;
