/**
 * agent-OS spike-01: end-to-end minimum loop
 *
 * Single point penetration. One run validates 4 assumptions simultaneously:
 *   A1: env.AI.run routes to model (Workers AI here; third-party in spike-4)
 *   A2: DO + SQLite as ledger backend
 *   A3: HTTP fetch -> DO RPC (stub.submit) round-trip
 *   A4: on(eventKind, handler) fires inside the same DO when log() emits that event
 *
 * Total ~150 lines TS. No CF Agents framework, no Workflows, no Sandbox.
 * Those come in spike-2/3.
 */

import { DurableObject } from "cloudflare:workers";

// ============================================================
//                          TYPES
// ============================================================

interface Env {
  AI: Ai;
  AGENT_DO: DurableObjectNamespace<AgentDO>;
}

interface SubmitSpec {
  scope: string;
  prompt: string;
  model?: string;
}

interface LedgerEvent {
  id: number;
  ts: number;
  kind: string;
  scope: string;
  payload: unknown;
}

// ============================================================
//                       TRIVIAL TOOL
// ============================================================

const tools = [
  {
    type: "function",
    function: {
      name: "get_current_time",
      description: "Returns the current ISO timestamp.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
];

function dispatchTool(name: string, _args: Record<string, unknown>): unknown {
  if (name === "get_current_time") return { iso: new Date().toISOString() };
  throw new Error(`Unknown tool: ${name}`);
}

// ============================================================
//                         AgentDO
// ============================================================

export class AgentDO extends DurableObject<Env> {
  private readonly handlers = new Map<string, (event: LedgerEvent) => void>();

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        scope TEXT NOT NULL,
        payload TEXT NOT NULL
      )
    `);
  }

  // ---------- 4-algebra primitives ----------

  /** log: write event into ledger, fire any on() handler */
  private log(kind: string, payload: unknown, scope: string): LedgerEvent {
    const ts = Date.now();
    const payloadStr = JSON.stringify(payload);
    const cursor = this.ctx.storage.sql.exec(
      "INSERT INTO events (ts, kind, scope, payload) VALUES (?, ?, ?, ?) RETURNING id",
      ts, kind, scope, payloadStr,
    );
    const id = Number(cursor.one().id);
    const event: LedgerEvent = { id, ts, kind, scope, payload };
    const handler = this.handlers.get(kind);
    if (handler) handler(event);
    return event;
  }

  /** on: reactive subscribe (spike scope: in-memory per submit() call) */
  private on(kind: string, handler: (event: LedgerEvent) => void) {
    this.handlers.set(kind, handler);
  }

  // ---------- public RPC ----------

  async submit(spec: SubmitSpec) {
    const model = spec.model ?? "@cf/openai/gpt-oss-120b";

    // A4: register on() handler before the loop emits agent.delivered
    let deliveredFired = false;
    this.on("agent.delivered", (e) => {
      deliveredFired = true;
      console.log(
        `[on('agent.delivered')] fired scope=${e.scope} payload=${JSON.stringify(e.payload).slice(0, 100)}`,
      );
    });

    const ingest = this.log("chat.ingested", { prompt: spec.prompt }, spec.scope);

    const messages: any[] = [{ role: "user", content: spec.prompt }];

    for (let iter = 0; iter < 5; iter++) {
      const resp: any = await this.env.AI.run(model as any, { messages, tools } as any);
      this.log("llm.response", { iter, raw: resp }, spec.scope);

      const text: string =
        resp?.response ?? resp?.choices?.[0]?.message?.content ?? "";
      const toolCalls: any[] =
        resp?.tool_calls ?? resp?.choices?.[0]?.message?.tool_calls ?? [];

      messages.push({
        role: "assistant",
        content: text,
        tool_calls: toolCalls.length ? toolCalls : undefined,
      });

      if (toolCalls.length === 0) {
        this.log("agent.delivered", { final: text }, spec.scope);
        const countRow = this.ctx.storage.sql
          .exec("SELECT COUNT(*) AS c FROM events WHERE scope = ?", spec.scope)
          .one();
        return {
          ok: true,
          runId: ingest.id,
          final: text,
          eventCount: Number(countRow.c),
          deliveredFired,
        };
      }

      for (const tc of toolCalls) {
        const fn = tc.function?.name ?? tc.name;
        const rawArgs = tc.function?.arguments ?? tc.arguments ?? {};
        const args =
          typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs;
        const result = dispatchTool(fn, args);
        this.log("tool.executed", { name: fn, args, result }, spec.scope);
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify(result),
        });
      }
    }

    this.log("agent.aborted", { reason: "max_iterations" }, spec.scope);
    return {
      ok: false,
      runId: ingest.id,
      final: "(max iterations)",
      eventCount: -1,
      deliveredFired,
    };
  }

  /** ledger query for verification */
  async events(scope: string): Promise<LedgerEvent[]> {
    const rows = this.ctx.storage.sql
      .exec("SELECT * FROM events WHERE scope = ? ORDER BY id", scope)
      .toArray();
    return rows.map((r: any) => ({
      id: Number(r.id),
      ts: Number(r.ts),
      kind: String(r.kind),
      scope: String(r.scope),
      payload: JSON.parse(String(r.payload)),
    }));
  }
}

// ============================================================
//                       WORKER ENTRY
// ============================================================

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "POST" && url.pathname === "/submit") {
      const body = (await req.json()) as SubmitSpec;
      if (!body.scope || !body.prompt) {
        return Response.json(
          { error: "scope and prompt required" },
          { status: 400 },
        );
      }
      const stub = env.AGENT_DO.get(env.AGENT_DO.idFromName(body.scope));
      const result = await stub.submit(body);
      return Response.json(result);
    }

    if (req.method === "GET" && url.pathname.startsWith("/events/")) {
      const scope = decodeURIComponent(
        url.pathname.slice("/events/".length),
      );
      const stub = env.AGENT_DO.get(env.AGENT_DO.idFromName(scope));
      const events = await stub.events(scope);
      return Response.json(events);
    }

    return new Response(
      [
        "agent-os spike-01",
        "",
        "POST /submit  { scope, prompt, model? }",
        "GET  /events/:scope",
        "",
        "default model: @cf/openai/gpt-oss-120b (Workers AI, free)",
        "third-party models (anthropic/...) need unified billing credits.",
      ].join("\n"),
      { headers: { "content-type": "text/plain" } },
    );
  },
} satisfies ExportedHandler<Env>;
