/**
 * agent-OS example: Effect-compliant rewrite of spike-01, extended with v0.2 on().
 *
 * v0.2 additions:
 *   - AgentDO constructor registers on("agent.delivered", ...) handler
 *   - Handler increments an in-memory counter
 *   - GET /handler-count/:scope exposes the counter
 *
 * Validates that ledger.log inside submitAgent fires registered handlers,
 * implementing spec 24 §5.1 reactive face.
 */

import {
  AgentDOBase,
  type AgentDOEnv,
  type LedgerEventRpc,
  type SubmitSpec,
  type Tool,
} from "@agent-os/core";

interface Env extends AgentDOEnv {
  AI: Ai;
  AGENT_DO: DurableObjectNamespace<AgentDO>;
}

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

export class AgentDO extends AgentDOBase<Env> {
  private deliveredCount = 0;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.on("agent.delivered", async (event: LedgerEventRpc) => {
      this.deliveredCount += 1;
      console.log(
        `[on('agent.delivered')] fired scope=${event.scope} runCount=${this.deliveredCount}`,
      );
    });
  }

  /** RPC: how many times the agent.delivered handler has fired. */
  getHandlerCount(): Promise<number> {
    return Promise.resolve(this.deliveredCount);
  }
}

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

async function handleHandlerCount(scope: string, env: Env): Promise<Response> {
  const stub = env.AGENT_DO.get(env.AGENT_DO.idFromName(scope));
  const count: number = await stub.getHandlerCount();
  return Response.json({ count });
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

    if (req.method === "GET" && url.pathname.startsWith("/handler-count/")) {
      const scope = decodeURIComponent(
        url.pathname.slice("/handler-count/".length),
      );
      return handleHandlerCount(scope, env);
    }

    return new Response(
      [
        "agent-os example: spike-01-effect (v0.2 on() demo)",
        "",
        "POST /submit            { scope, prompt, model?, budget? }",
        "GET  /events/:scope",
        "GET  /handler-count/:scope",
        "",
        "AgentDO registers on('agent.delivered') in constructor → counter++.",
      ].join("\n"),
      { headers: { "content-type": "text/plain" } },
    );
  },
} satisfies ExportedHandler<Env>;
