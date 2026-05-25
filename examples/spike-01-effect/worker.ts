/**
 * agent-OS example: Effect-compliant rewrite of spike-01.
 *
 * Mirrors spike-01's behavior end-to-end but uses @agent-os/core.
 * App-side code is plain TypeScript (async/await/Promise) — zero Effect imports.
 *
 * Validates that the Effect internals + Promise boundary translation
 * produce the same observable behavior as the vanilla DO spike.
 *
 * NOTE: examples are exempt from EFF rules (like spikes). Production app
 * code that imports @agent-os/core may freely use async/await; the EFF
 * discipline applies only to packages/core internals.
 */

import {
  AgentDOBase,
  type AgentDOEnv,
  type LedgerEventRpc,
  type SubmitSpec,
  type Tool,
} from "@agent-os/core";

// ============================================================
//                          ENV
// ============================================================

interface Env extends AgentDOEnv {
  AI: Ai;
  AGENT_DO: DurableObjectNamespace<AgentDO>;
}

// ============================================================
//                     APP-DEFINED TOOL
// ============================================================
// Plain TS — Tool<args, result> is just an object with execute returning Promise.

const getCurrentTime: Tool<Record<string, never>, { iso: string }> = {
  definition: {
    type: "function",
    function: {
      name: "get_current_time",
      description: "Returns the current ISO timestamp.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  execute: async () => ({ iso: new Date().toISOString() }),
};

// ============================================================
//                     APP-DEFINED AGENT DO
// ============================================================
// Subclass AgentDOBase — gets submit() + events() for free.

export class AgentDO extends AgentDOBase<Env> {}

// ============================================================
//                     WORKER ENTRY
// ============================================================

interface SubmitBody {
  scope: string;
  prompt: string;
  model?: string;
  budget?: {
    tokens?: number;
    maxTurns?: number;
    toolRetries?: number;
    timeMs?: number;
  };
}

async function handleSubmit(req: Request, env: Env): Promise<Response> {
  const body = await req.json<SubmitBody>();
  if (!body.scope || !body.prompt) {
    return Response.json(
      { error: "scope and prompt required" },
      { status: 400 },
    );
  }
  const spec: SubmitSpec = {
    intent: body.prompt,
    context: {},
    agent: {
      provider: "@cf",
      model: body.model ?? "openai/gpt-oss-120b",
    },
    tools: { get_current_time: getCurrentTime },
    budget: {
      tokens: body.budget?.tokens ?? 10_000,
      maxTurns: body.budget?.maxTurns ?? 5,
      toolRetries: body.budget?.toolRetries ?? 2,
      ...(body.budget?.timeMs !== undefined
        ? { timeMs: body.budget.timeMs }
        : {}),
    },
    deliver: { scope: body.scope, event: "agent.delivered" },
  };
  const stub = env.AGENT_DO.get(env.AGENT_DO.idFromName(body.scope));
  const result = await stub.submit(spec);
  return Response.json(result);
}

async function handleEvents(scope: string, env: Env): Promise<Response> {
  const stub = env.AGENT_DO.get(env.AGENT_DO.idFromName(scope));
  const events: LedgerEventRpc[] = await stub.events(scope);
  return Response.json(events);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "POST" && url.pathname === "/submit") {
      return handleSubmit(req, env);
    }

    if (req.method === "GET" && url.pathname.startsWith("/events/")) {
      const scope = decodeURIComponent(url.pathname.slice("/events/".length));
      return handleEvents(scope, env);
    }

    return new Response(
      [
        "agent-os example: spike-01-effect (Effect-rewritten)",
        "",
        "POST /submit  { scope, prompt, model? }",
        "GET  /events/:scope",
        "",
        "uses @agent-os/core@workspace, model default: @cf/openai/gpt-oss-120b",
      ].join("\n"),
      { headers: { "content-type": "text/plain" } },
    );
  },
} satisfies ExportedHandler<Env>;
