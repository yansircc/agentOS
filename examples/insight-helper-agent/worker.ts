/**
 * Insight Helper backend — Worker HTTP entry.
 *
 * Routes external HTTP requests onto the InterviewDO scoped by sessionId.
 * Each route is a one-line emit/read against the DO. No agent logic here.
 *
 *   POST /start  {sessionId, topic, businessContext?}
 *                → INTERVIEW_DO.idFromName(sessionId).emitEvent("interview.start", payload)
 *                → on("interview.start") inside DO fires → submit → next turn
 *
 *   POST /answer {sessionId, answers}
 *                → emitEvent("interview.answer", {answers})
 *                → on("interview.answer") → submit → next turn or final
 *
 *   GET  /events/:sessionId
 *                → returns full ledger for the session (frontend reads
 *                  tool.executed for the latest unanswered questions,
 *                  and interview.turn.delivered for the final brief).
 *
 * No SSE / no WebSocket in v0. Frontend polls /events. WebSocket-hibernation
 * delivery is a future concern; HTTP polling is sufficient for dogfood.
 */

import type { InterviewDO } from "./interview-do";

interface Env {
  readonly AI: Ai;
  readonly INTERVIEW_DO: DurableObjectNamespace<InterviewDO>;
}

const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      ...(init.headers ?? {}),
    },
  });

const ROOT_BODY = `agent-OS example: insight-helper-agent (v0 dogfood)

POST /start                    { sessionId, topic, businessContext? }
POST /answer                   { sessionId, answers }
GET  /events/:sessionId        full ledger for the session
`;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type",
        },
      });
    }

    const url = new URL(req.url);

    if (url.pathname === "/" && req.method === "GET") {
      return new Response(ROOT_BODY, {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "access-control-allow-origin": "*",
        },
      });
    }

    if (url.pathname === "/start" && req.method === "POST") {
      const body = (await req.json()) as {
        sessionId?: unknown;
        topic?: unknown;
        businessContext?: unknown;
      };
      if (typeof body.sessionId !== "string" || body.sessionId.length === 0) {
        return json({ error: "sessionId required" }, { status: 400 });
      }
      if (typeof body.topic !== "string" || body.topic.length === 0) {
        return json({ error: "topic required" }, { status: 400 });
      }
      const stub = env.INTERVIEW_DO.get(
        env.INTERVIEW_DO.idFromName(body.sessionId),
      );
      const { id } = await stub.emitEvent({
        event: "interview.start",
        data: {
          topic: body.topic,
          businessContext:
            typeof body.businessContext === "string"
              ? body.businessContext
              : undefined,
        },
      });
      return json({ ok: true, eventId: id });
    }

    if (url.pathname === "/answer" && req.method === "POST") {
      const body = (await req.json()) as {
        sessionId?: unknown;
        answers?: unknown;
      };
      if (typeof body.sessionId !== "string" || body.sessionId.length === 0) {
        return json({ error: "sessionId required" }, { status: 400 });
      }
      if (
        body.answers === null ||
        body.answers === undefined ||
        typeof body.answers !== "object"
      ) {
        return json({ error: "answers required" }, { status: 400 });
      }
      const stub = env.INTERVIEW_DO.get(
        env.INTERVIEW_DO.idFromName(body.sessionId),
      );
      const { id } = await stub.emitEvent({
        event: "interview.answer",
        data: { answers: body.answers },
      });
      return json({ ok: true, eventId: id });
    }

    if (url.pathname.startsWith("/events/") && req.method === "GET") {
      const sessionId = decodeURIComponent(url.pathname.slice("/events/".length));
      if (sessionId.length === 0) {
        return json({ error: "sessionId required" }, { status: 400 });
      }
      const stub = env.INTERVIEW_DO.get(env.INTERVIEW_DO.idFromName(sessionId));
      const events = await stub.events();
      return json(events);
    }

    return new Response("not found", { status: 404 });
  },
};

export { InterviewDO } from "./interview-do";
