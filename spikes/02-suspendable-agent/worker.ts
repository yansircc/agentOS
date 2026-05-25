/**
 * agent-OS spike-02: suspendable agent via CF Workflows
 *
 * Validates 4 assumptions in one e2e run:
 *   B1: step.waitForEvent actually suspends (status: paused/waiting after ask)
 *   B2: workflow instance id = app-controlled scope string
 *   B3: workflow can call env.AI.run + cross-DO RPC from inside steps
 *   B4: sendEvent resumes the workflow to completion
 *
 * Scenario (single-round interview, Insight-Helper-style):
 *   start(scope, topic) -> workflow init -> ask LLM-generated question
 *                       -> SUSPENDED at waitForEvent
 *   answer(scope, text) -> sendEvent -> record -> LLM finalize brief -> complete
 */

import {
  DurableObject,
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";

// ============================================================
//                          TYPES
// ============================================================

interface Env {
  AI: Ai;
  AGENT_DO: DurableObjectNamespace<AgentDO>;
  INTERVIEW_WORKFLOW: Workflow;
}

interface StartSpec {
  scope: string;
  topic: string;
}

interface AnswerSpec {
  scope: string;
  answer: string;
}

interface InterviewParams {
  scope: string;
  topic: string;
}

interface LedgerEvent {
  id: number;
  ts: number;
  kind: string;
  scope: string;
  payload: unknown;
}

// ============================================================
//                       AgentDO (ledger)
// ============================================================

export class AgentDO extends DurableObject<Env> {
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

  async log(
    kind: string,
    payload: unknown,
    scope: string,
  ): Promise<LedgerEvent> {
    const ts = Date.now();
    const payloadStr = JSON.stringify(payload);
    const cursor = this.ctx.storage.sql.exec(
      "INSERT INTO events (ts, kind, scope, payload) VALUES (?, ?, ?, ?) RETURNING id",
      ts,
      kind,
      scope,
      payloadStr,
    );
    const id = Number(cursor.one().id);
    return { id, ts, kind, scope, payload };
  }

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
//                  InterviewWorkflow
// ============================================================

const MODEL = "@cf/openai/gpt-oss-120b";

function getStub(env: Env, scope: string) {
  return env.AGENT_DO.get(env.AGENT_DO.idFromName(scope));
}

async function llm(env: Env, system: string, user: string): Promise<string> {
  const resp: any = await env.AI.run(
    MODEL as any,
    {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    } as any,
  );
  return resp?.choices?.[0]?.message?.content ?? resp?.response ?? "";
}

export class InterviewWorkflow extends WorkflowEntrypoint<Env, InterviewParams> {
  async run(
    event: WorkflowEvent<InterviewParams>,
    step: WorkflowStep,
  ): Promise<{ brief: string }> {
    const { scope, topic } = event.payload;

    await step.do("init", async () => {
      await getStub(this.env, scope).log("interview.started", { topic }, scope);
    });

    const question = await step.do("ask question", async () => {
      const text = await llm(
        this.env,
        "You are an interviewer. Ask one specific clarifying question about the user's topic, so we can write a better brief later. Be concise; one sentence.",
        `Topic: ${topic}`,
      );
      await getStub(this.env, scope).log(
        "interview.asked",
        { question: text },
        scope,
      );
      return text;
    });

    // === SUSPEND HERE until external sendEvent ===
    const answerEvent = await step.waitForEvent<{ text: string }>(
      "wait for user answer",
      { type: "user-answer", timeout: "1 hour" },
    );
    const answer = answerEvent.payload.text;

    await step.do("record answer", async () => {
      await getStub(this.env, scope).log(
        "interview.answered",
        { answer },
        scope,
      );
    });

    const brief = await step.do("finalize brief", async () => {
      const text = await llm(
        this.env,
        "Write a one-paragraph writing brief based on the topic and the user's clarification. Output only the brief, no preamble.",
        `Topic: ${topic}\nQuestion asked: ${question}\nUser answer: ${answer}`,
      );
      await getStub(this.env, scope).log(
        "brief.written",
        { brief: text },
        scope,
      );
      return text;
    });

    return { brief };
  }
}

// ============================================================
//                       WORKER ENTRY
// ============================================================

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "POST" && url.pathname === "/start") {
      const body = (await req.json()) as StartSpec;
      if (!body.scope || !body.topic) {
        return Response.json(
          { error: "scope and topic required" },
          { status: 400 },
        );
      }
      const instance = await env.INTERVIEW_WORKFLOW.create({
        id: body.scope,
        params: { scope: body.scope, topic: body.topic },
      });
      return Response.json({
        instanceId: instance.id,
        status: await instance.status(),
      });
    }

    if (req.method === "POST" && url.pathname === "/answer") {
      const body = (await req.json()) as AnswerSpec;
      if (!body.scope || !body.answer) {
        return Response.json(
          { error: "scope and answer required" },
          { status: 400 },
        );
      }
      const instance = await env.INTERVIEW_WORKFLOW.get(body.scope);
      await instance.sendEvent({
        type: "user-answer",
        payload: { text: body.answer },
      });
      return Response.json({ ok: true, status: await instance.status() });
    }

    if (req.method === "GET" && url.pathname.startsWith("/status/")) {
      const scope = decodeURIComponent(
        url.pathname.slice("/status/".length),
      );
      const instance = await env.INTERVIEW_WORKFLOW.get(scope);
      return Response.json(await instance.status());
    }

    if (req.method === "GET" && url.pathname.startsWith("/events/")) {
      const scope = decodeURIComponent(
        url.pathname.slice("/events/".length),
      );
      const events = await getStub(env, scope).events(scope);
      return Response.json(events);
    }

    return new Response(
      [
        "agent-os spike-02 (suspendable agent)",
        "",
        "POST /start   { scope, topic }",
        "POST /answer  { scope, answer }",
        "GET  /status/:scope",
        "GET  /events/:scope",
      ].join("\n"),
      { headers: { "content-type": "text/plain" } },
    );
  },
} satisfies ExportedHandler<Env>;
