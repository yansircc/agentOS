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
  withQuota,
} from "@agent-os/core";

interface Env extends AgentDOEnv {
  AI: Ai;
  AGENT_DO: DurableObjectNamespace<AgentDO>;
}

const baseGetCurrentTime: Tool<Record<string, never>, { iso: string }> = {
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

// v0.2.7 demo: wrap with quota — max 2 calls per 60-second window per DO scope.
// Existing tests do at most 2 submits per scope (= 2 calls), so they still pass.
// New quota test does 3 submits per scope; the 3rd hits the limit.
const getCurrentTime = withQuota(baseGetCurrentTime, {
  key: "time",
  windowMs: 60_000,
  limit: 2,
});

export class AgentDO extends AgentDOBase<Env> {
  private deliveredCount = 0;
  private scheduledFiredCount = 0;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.on("agent.delivered", async (event: LedgerEventRpc) => {
      this.deliveredCount += 1;
      console.log(
        `[on('agent.delivered')] fired scope=${event.scope} runCount=${this.deliveredCount}`,
      );
    });
    this.on("test.scheduled", async (event: LedgerEventRpc) => {
      this.scheduledFiredCount += 1;
      console.log(
        `[on('test.scheduled')] fired scope=${event.scope} payload=${JSON.stringify(event.payload).slice(0, 80)}`,
      );
    });
  }

  getHandlerCount(): Promise<number> {
    return Promise.resolve(this.deliveredCount);
  }

  getScheduledFiredCount(): Promise<number> {
    return Promise.resolve(this.scheduledFiredCount);
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
    deliver: { event: "agent.delivered" },
  };
  const stub = env.AGENT_DO.get(env.AGENT_DO.idFromName(body.scope));
  const result = await stub.submit(spec);
  return Response.json(result);
}

async function handleEvents(scope: string, env: Env): Promise<Response> {
  const stub = env.AGENT_DO.get(env.AGENT_DO.idFromName(scope));
  const events: LedgerEventRpc[] = await stub.events();
  return Response.json(events);
}

async function handleHandlerCount(scope: string, env: Env): Promise<Response> {
  const stub = env.AGENT_DO.get(env.AGENT_DO.idFromName(scope));
  const count: number = await stub.getHandlerCount();
  return Response.json({ count });
}

interface ScheduleBody {
  scope: string;
  delayMs: number;
  event: string;
  data: unknown;
}

async function handleSchedule(req: Request, env: Env): Promise<Response> {
  const body = await req.json<ScheduleBody>();
  if (!body.scope || !body.event || typeof body.delayMs !== "number") {
    return Response.json(
      { error: "scope, event, delayMs required" },
      { status: 400 },
    );
  }
  const at = Date.now() + body.delayMs;
  const stub = env.AGENT_DO.get(env.AGENT_DO.idFromName(body.scope));
  const result = await stub.scheduleEvent({
    at,
    event: body.event,
    data: body.data,
  });
  return Response.json({ ...result, scheduledFireAt: at });
}

async function handleScheduledFiredCount(
  scope: string,
  env: Env,
): Promise<Response> {
  const stub = env.AGENT_DO.get(env.AGENT_DO.idFromName(scope));
  const count: number = await stub.getScheduledFiredCount();
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

    if (req.method === "POST" && url.pathname === "/schedule") {
      return handleSchedule(req, env);
    }

    if (
      req.method === "GET" &&
      url.pathname.startsWith("/scheduled-fired-count/")
    ) {
      const scope = decodeURIComponent(
        url.pathname.slice("/scheduled-fired-count/".length),
      );
      return handleScheduledFiredCount(scope, env);
    }

    return new Response(
      [
        "agent-os example: spike-01-effect (v0.2 reactive + scheduler demo)",
        "",
        "POST /submit                       { scope, prompt, model?, budget? }",
        "GET  /events/:scope",
        "GET  /handler-count/:scope         (agent.delivered)",
        "POST /schedule                     { scope, delayMs, event, data }",
        "GET  /scheduled-fired-count/:scope (test.scheduled)",
      ].join("\n"),
      { headers: { "content-type": "text/plain" } },
    );
  },
} satisfies ExportedHandler<Env>;
