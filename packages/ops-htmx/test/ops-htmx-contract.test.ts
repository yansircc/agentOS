import { describe, expect, it } from "vitest";

import { mountOpsHtmx } from "../src";

interface SeenRequest {
  readonly method: string;
  readonly pathname: string;
  readonly search: string;
  readonly cookie: string | null;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const makeApi = () => {
  const seen: SeenRequest[] = [];
  const fetchApi = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    seen.push({
      method: req.method,
      pathname: url.pathname,
      search: url.search,
      cookie: req.headers.get("cookie"),
    });

    if (url.pathname === "/__ops/api/scopes") {
      return json({
        scopes: [
          { scope: "thread/a", surface: "agent-do/v0.3" },
          { scope: "thread/<unsafe>", surface: "agent-do/v0.3" },
          { scope: "artifact/blob", surface: "opaque" },
        ],
      });
    }

    const scopeRuns = "/__ops/api/scopes/thread%2Fa/runs";
    if (url.pathname === scopeRuns) {
      return json({
        runs: [
          {
            runId: 42,
            startedAt: 1_800_000_000_000,
            status: {
              kind: "delivered",
              at: 1_800_000_001_100,
              event: "answer.ready",
            },
            durationMs: 1_100,
          },
          {
            runId: 41,
            startedAt: 1_799_999_000_000,
            status: {
              kind: "open_without_terminal",
              startedAt: 1_799_999_000_000,
            },
          },
        ],
        nextCursor: null,
      });
    }

    if (url.pathname === "/__ops/api/scopes/thread%2Fa/runs/42/trace") {
      return json({
        runId: 42,
        startedAt: 1_800_000_000_000,
        turns: [
          {
            index: 0,
            at: 1_800_000_000_400,
            text: "hello <b>operator</b>",
            usage: { tokens: 5 },
          },
        ],
        toolCalls: [
          {
            at: 1_800_000_000_800,
            name: "lookup",
            args: { q: "x" },
            result: { html: "<img src=x onerror=alert(1)>" },
          },
        ],
        terminal: {
          kind: "delivered",
          at: 1_800_000_001_100,
          event: "answer.ready",
          payload: { html: "<script>alert(1)</script>" },
        },
      });
    }

    if (url.pathname === "/__ops/api/scopes/thread%2Fa/runs/42/status") {
      return json({
        kind: "delivered",
        at: 1_800_000_001_100,
        event: "answer.ready",
      });
    }

    if (url.pathname === "/__ops/api/scopes/thread%2Fa/events") {
      expect(url.searchParams.get("afterId")).toBe("5");
      expect(url.searchParams.get("limit")).toBe("2");
      expect(url.searchParams.get("kinds")).toBe(
        "agent.run.started,tool.executed",
      );
      return json([
        {
          id: 6,
          ts: 1_800_000_000_000,
          kind: "agent.run.started",
          scope: "thread/a",
          payload: { html: "<svg onload=alert(1)>" },
        },
      ]);
    }

    if (url.pathname === "/__ops/api/scopes/thread%2Fa/quota") {
      expect(url.searchParams.get("key")).toBe("llm");
      expect(url.searchParams.get("windowMs")).toBe("Infinity");
      expect(url.searchParams.get("limit")).toBe("10");
      return json({ consumed: 2, limit: 10, remaining: 8, refundable: 0 });
    }

    if (url.pathname === "/__ops/api/scopes/thread%2Fa/resource") {
      expect(url.searchParams.get("key")).toBe("gpu");
      return json({
        granted: 4,
        reserved: 1,
        consumed: 2,
        available: 1,
        reservations: [{ id: "r1", amount: 1 }],
      });
    }

    if (url.pathname === "/__ops/api/scopes/thread%2Fa/admission") {
      expect(url.searchParams.get("key")).toBe("encoded-attempt");
      return json({ status: "unknown" });
    }

    if (url.pathname.startsWith("/__ops/api/scopes/artifact%2Fblob/")) {
      return json(
        {
          error: "not_introspectable",
          message: "scope is opaque",
        },
        501,
      );
    }

    return json({ error: "scope_not_found", message: url.pathname }, 404);
  };

  return { fetchApi, seen };
};

describe("@agent-os/ops-htmx", () => {
  it("requires apiFetch instead of inventing a data source", () => {
    expect(() => mountOpsHtmx({} as never)).toThrow("apiFetch is required");
  });

  it("renders the shell from ops-api GET responses and forwards auth headers", async () => {
    const api = makeApi();
    const handler = mountOpsHtmx({ apiFetch: api.fetchApi });
    const res = await handler(
      new Request("https://ops.test/__ops?scope=thread/a&runId=42&tab=trace", {
        headers: { cookie: "sid=abc" },
      }),
    );
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain("@agent-os/ops");
    expect(html).toContain("https://unpkg.com/htmx.org@2.0.4");
    expect(html).toContain("thread/a");
    expect(html).toContain("run <b>#42</b>");
    expect(html).toContain('href="/__ops?scope=thread%2Fa&amp;runId=42&amp;tab=events"');
    expect(html).toContain('hx-get="/__ops/fragments/events?scope=thread%2Fa&amp;runId=42&amp;limit=100"');
    expect(html).toContain('hx-push-url="/__ops?scope=thread%2Fa&amp;runId=42&amp;tab=events"');
    expect(html).toContain("hello &lt;b&gt;operator&lt;/b&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html.toLowerCase()).not.toMatch(
      /\b(change|lead|site|schema|conversation)\b/,
    );
    expect(api.seen.map((r) => r.pathname)).toEqual([
      "/__ops/api/scopes",
      "/__ops/api/scopes/thread%2Fa/runs",
      "/__ops/api/scopes/thread%2Fa/runs/42/trace",
      "/__ops/api/scopes/thread%2Fa/runs/42/status",
    ]);
    expect(api.seen.every((r) => r.method === "GET")).toBe(true);
    expect(api.seen.every((r) => r.cookie === "sid=abc")).toBe(true);
  });

  it("deep-links shell tab state without using the URL as data truth", async () => {
    const api = makeApi();
    const handler = mountOpsHtmx({ apiFetch: api.fetchApi });
    const res = await handler(
      new Request(
        "https://ops.test/__ops?scope=thread/a&runId=42&tab=events&afterId=5&limit=2&kinds=agent.run.started,tool.executed",
      ),
    );
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain("event stream");
    expect(html).toContain('href="/__ops?scope=thread%2Fa&amp;runId=42&amp;tab=trace"');
    expect(html).toContain('hx-get="/__ops/fragments/select-run?scope=thread%2Fa&amp;runId=42"');
    expect(html).toContain('hx-push-url="/__ops?scope=thread%2Fa&amp;runId=42&amp;tab=trace"');
    expect(html).toContain('<details><summary>payload</summary><pre>');
    expect(api.seen.map((r) => r.pathname)).toEqual([
      "/__ops/api/scopes",
      "/__ops/api/scopes/thread%2Fa/runs",
      "/__ops/api/scopes/thread%2Fa/events",
    ]);
    expect(api.seen.at(-1)?.search).toBe(
      "?limit=2&afterId=5&kinds=agent.run.started%2Ctool.executed",
    );
  });

  it("rejects non-GET UI routes", async () => {
    const handler = mountOpsHtmx({ apiFetch: makeApi().fetchApi });
    const res = await handler(new Request("https://ops.test/__ops", { method: "POST" }));
    expect(res.status).toBe(405);
    await expect(res.text()).resolves.toContain("method_not_allowed");
  });

  it("treats the shell base and trailing slash as the same route", async () => {
    const handler = mountOpsHtmx({ apiFetch: makeApi().fetchApi });
    const res = await handler(new Request("https://ops.test/__ops/"));
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toContain("thread/a");
  });

  it("renders scopes as escaped HTMX rows", async () => {
    const handler = mountOpsHtmx({ apiFetch: makeApi().fetchApi });
    const res = await handler(
      new Request("https://ops.test/__ops/fragments/scopes?prefix=thread/"),
    );
    const html = await res.text();
    expect(html).toContain("hx-get=");
    expect(html).toContain('hx-push-url="/__ops?scope=thread%2Fa&amp;tab=trace"');
    expect(html).toContain("thread/&lt;unsafe&gt;");
    expect(html).not.toContain("thread/<unsafe>");
  });

  it("passes event cursor filters through and escapes payload JSON", async () => {
    const handler = mountOpsHtmx({ apiFetch: makeApi().fetchApi });
    const res = await handler(
      new Request(
        "https://ops.test/__ops/fragments/events?scope=thread/a&runId=42&afterId=5&limit=2&kinds=agent.run.started,tool.executed",
      ),
    );
    const html = await res.text();
    expect(html).toContain("GET /scopes/:scope/events");
    expect(html).toContain('href="/__ops?scope=thread%2Fa&amp;runId=42&amp;tab=trace"');
    expect(html).toContain('hx-get="/__ops/fragments/select-run?scope=thread%2Fa&amp;runId=42"');
    expect(html).toContain('hx-push-url="/__ops?scope=thread%2Fa&amp;runId=42&amp;tab=trace"');
    expect(html).toContain('<details><summary>payload</summary><pre>');
    expect(html).not.toContain("<details open>");
    expect(html).toContain('name="runId" value="42"');
    expect(html).toContain("&lt;svg onload=alert(1)&gt;");
    expect(html).not.toContain("<svg onload=alert(1)>");
  });

  it("renders opaque scopes as explicit not_introspectable state without run RPC", async () => {
    const api = makeApi();
    const handler = mountOpsHtmx({ apiFetch: api.fetchApi });
    const res = await handler(
      new Request("https://ops.test/__ops/fragments/select-scope?scope=artifact/blob"),
    );
    const html = await res.text();
    expect(html).toContain("hx-swap-oob");
    expect(html).toContain("not_introspectable");
    expect(api.seen.map((r) => r.pathname)).toEqual(["/__ops/api/scopes"]);
  });

  it("select-run returns out-of-band run and workspace fragments", async () => {
    const api = makeApi();
    const handler = mountOpsHtmx({ apiFetch: api.fetchApi });
    const res = await handler(
      new Request("https://ops.test/__ops/fragments/select-run?scope=thread/a&runId=42"),
    );
    const html = await res.text();
    expect(html).toContain('href="/__ops?scope=thread%2Fa&amp;runId=42&amp;tab=trace"');
    expect(html).toContain('hx-push-url="/__ops?scope=thread%2Fa&amp;runId=42&amp;tab=trace"');
    expect(html).toContain('id="runs-panel" hx-swap-oob="innerHTML"');
    expect(html).toContain('id="workspace-panel" hx-swap-oob="innerHTML"');
    expect(api.seen.map((r) => r.pathname)).toEqual([
      "/__ops/api/scopes/thread%2Fa/runs",
      "/__ops/api/scopes/thread%2Fa/runs/42/trace",
      "/__ops/api/scopes/thread%2Fa/runs/42/status",
    ]);
  });

  it("telemetry fragment uses read-only projection GET endpoints", async () => {
    const api = makeApi();
    const handler = mountOpsHtmx({ apiFetch: api.fetchApi });
    const res = await handler(
      new Request(
        "https://ops.test/__ops/fragments/telemetry?scope=thread/a&runId=42&quotaKey=llm&windowMs=Infinity&quotaLimit=10&resourceKey=gpu&admissionKey=encoded-attempt",
      ),
    );
    const html = await res.text();
    expect(html).toContain('href="/__ops?scope=thread%2Fa&amp;runId=42&amp;tab=trace"');
    expect(html).toContain('hx-get="/__ops/fragments/select-run?scope=thread%2Fa&amp;runId=42"');
    expect(html).toContain('hx-push-url="/__ops?scope=thread%2Fa&amp;runId=42&amp;tab=trace"');
    expect(html).toContain('name="runId" value="42"');
    expect(html).toContain("GET /scopes/:scope/quota");
    expect(html).toContain("GET /scopes/:scope/resource");
    expect(html).toContain("GET /scopes/:scope/admission");
    expect(api.seen.map((r) => r.pathname)).toEqual([
      "/__ops/api/scopes/thread%2Fa/quota",
      "/__ops/api/scopes/thread%2Fa/resource",
      "/__ops/api/scopes/thread%2Fa/admission",
    ]);
    expect(api.seen.map((r) => r.search)).toEqual([
      "?key=llm&windowMs=Infinity&limit=10",
      "?key=gpu",
      "?key=encoded-attempt",
    ]);
    expect(api.seen.every((r) => r.method === "GET")).toBe(true);
  });
});
