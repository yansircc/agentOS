/**
 * @agent-os/ops-api — contract tests (spec-35 §6).
 *
 * Nine acceptance items, one describe block per item.
 */

import {
  type AgentDOIntrospection,
  type MountOpsApiOptions,
  type OpsAuth,
  type OpsPrincipal,
  type ResolvedScope,
  type ScopeResolver,
  type ScopeSummary,
  decodeAttemptKey,
  encodeAttemptKey,
  mountOpsApi,
} from "../src";
import type {
  AttemptKey,
  CapabilityLease,
  EventQueryOptions,
  LedgerEventRpc,
  QuotaState,
  ResourceState,
  RunStatus,
  RunTrace,
  StreamEventsOptions,
} from "@agent-os/core";

// ============================================================
// In-memory fakes
// ============================================================

class FakeAgentDO implements AgentDOIntrospection {
  constructor(public readonly rows: LedgerEventRpc[]) {}

  events(opts?: EventQueryOptions): Promise<LedgerEventRpc[]> {
    const afterId = opts?.afterId ?? 0;
    const kinds = opts?.kinds;
    const limit = opts?.limit ?? 1000;
    const filtered = this.rows
      .filter((r) => r.id > afterId)
      .filter((r) => (kinds === undefined ? true : kinds.includes(r.kind)));
    return Promise.resolve(filtered.slice(0, limit));
  }

  streamEvents(opts: StreamEventsOptions): Response {
    // Tests only assert the cursor passes through; emit a short SSE body
    // containing two rows past `afterId` to mimic spec-29 wire.
    const afterId = opts.afterId ?? 0;
    const rows = this.rows.filter((r) => r.id > afterId).slice(0, 2);
    const body = rows
      .map(
        (r) =>
          `event: ledger\nid: ${r.id}\ndata: ${JSON.stringify(r)}\n\n`,
      )
      .join("");
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "x-ops-test-resumed-from": String(afterId),
      },
    });
  }

  runTrace(runId: number | string): Promise<RunTrace> {
    const id = typeof runId === "number" ? runId : parseInt(runId, 10);
    const started = this.rows.find(
      (r) => r.id === id && r.kind === "agent.run.started",
    );
    if (started === undefined) {
      return Promise.resolve({
        runId: id,
        startedAt: 0,
        turns: [],
        toolCalls: [],
        terminal: null,
      });
    }
    return Promise.resolve({
      runId: id,
      startedAt: started.ts,
      turns: [],
      toolCalls: [],
      terminal: null,
    });
  }

  runStatus(runId: number | string): Promise<RunStatus> {
    const id = typeof runId === "number" ? runId : parseInt(runId, 10);
    const started = this.rows.find(
      (r) => r.id === id && r.kind === "agent.run.started",
    );
    if (started === undefined) {
      return Promise.resolve({
        kind: "orphaned",
        startedAt: 0,
        evidence: "no_run",
      });
    }
    return Promise.resolve({ kind: "open_without_terminal", startedAt: started.ts });
  }

  quotaState(spec: {
    key: string;
    windowMs: number;
    limit: number;
  }): Promise<QuotaState> {
    return Promise.resolve({
      consumed: 0,
      limit: spec.limit,
      remaining: spec.limit,
      refundable: 0,
    });
  }

  resourceState(key: string): Promise<ResourceState> {
    return Promise.resolve({
      granted: 0,
      reserved: 0,
      consumed: 0,
      available: 0,
      reservations: [],
    });
  }

  admissionLease(_key: AttemptKey): Promise<CapabilityLease | null> {
    void _key;
    return Promise.resolve(null);
  }
}

const summary = (scope: string): ScopeSummary => ({
  scope,
  surface: "agent-do/v0.3",
});

class FakeResolver implements ScopeResolver {
  constructor(
    public readonly entries: Map<string, ResolvedScope>,
    public readonly opaqueScopes: ReadonlySet<string> = new Set(),
  ) {}

  list(filter: {
    prefix?: string;
    limit?: number;
  }): Promise<{
    scopes: ReadonlyArray<ScopeSummary>;
    nextCursor: string | null;
  }> {
    const all = Array.from(this.entries.keys());
    const matched = all
      .filter((s) =>
        filter.prefix === undefined ? true : s.startsWith(filter.prefix),
      )
      .map((s) =>
        this.opaqueScopes.has(s)
          ? { scope: s, surface: "opaque" as const }
          : summary(s),
      );
    const limited = matched.slice(0, filter.limit ?? matched.length);
    return Promise.resolve({ scopes: limited, nextCursor: null });
  }

  resolve(scope: string): Promise<ResolvedScope | null> {
    return Promise.resolve(this.entries.get(scope) ?? null);
  }
}

interface FakeAuthRule {
  readonly subject: string;
  readonly scopes: ReadonlySet<string>;
  readonly streamScopes?: ReadonlySet<string>;
}

class FakeAuth implements OpsAuth {
  constructor(public readonly rules: ReadonlyArray<FakeAuthRule>) {}

  authenticate(req: Request): Promise<OpsPrincipal | null> {
    const subject = req.headers.get("x-test-principal");
    if (subject === null) return Promise.resolve(null);
    return Promise.resolve({ subject, claims: {} });
  }

  authorize(
    principal: OpsPrincipal,
    scope: string,
    action: "read" | "stream",
  ): Promise<boolean> {
    const rule = this.rules.find((r) => r.subject === principal.subject);
    if (rule === undefined) return Promise.resolve(false);
    if (action === "stream") {
      const allowed = rule.streamScopes ?? rule.scopes;
      return Promise.resolve(allowed.has(scope));
    }
    return Promise.resolve(rule.scopes.has(scope));
  }
}

// ============================================================
// Fixture: one scope with a small ledger
// ============================================================

const SCOPE = "thread/abc";
const ROWS: LedgerEventRpc[] = [
  { id: 1, ts: 1000, kind: "agent.run.started", scope: SCOPE, payload: { intent: "x" } },
  { id: 2, ts: 1010, kind: "chat.ingested", scope: SCOPE, payload: { runId: 1 } },
  { id: 3, ts: 1100, kind: "llm.response", scope: SCOPE, payload: { turn: { id: 1, index: 0 } } },
  { id: 4, ts: 1200, kind: "tool.executed", scope: SCOPE, payload: { runId: 1, name: "lookup" } },
  { id: 5, ts: 1300, kind: "agent.run.completed", scope: SCOPE, payload: { runId: 1, event: "answer.ready" } },
  { id: 6, ts: 2000, kind: "agent.run.started", scope: SCOPE, payload: { intent: "y" } },
  { id: 7, ts: 2050, kind: "agent.aborted.tool_error", scope: SCOPE, payload: { runId: 6, toolName: "lookup", cause: "Timeout" } },
  { id: 8, ts: 3000, kind: "agent.run.started", scope: SCOPE, payload: { intent: "z" } },
];

const makeHandler = (
  opts: {
    rows?: LedgerEventRpc[];
    extraScopes?: ReadonlyArray<string>;
    opaqueScopes?: ReadonlyArray<string>;
    rules?: ReadonlyArray<FakeAuthRule>;
  } = {},
): ((req: Request) => Promise<Response>) => {
  const rows = opts.rows ?? ROWS;
  const fakeDO = new FakeAgentDO(rows);
  const entries = new Map<string, ResolvedScope>();
  entries.set(SCOPE, { scope: SCOPE, surface: "agent-do/v0.3" });
  for (const s of opts.extraScopes ?? []) {
    entries.set(s, { scope: s, surface: "agent-do/v0.3" });
  }
  for (const s of opts.opaqueScopes ?? []) {
    entries.set(s, { scope: s, surface: "opaque" });
  }
  const resolver = new FakeResolver(
    entries,
    new Set(opts.opaqueScopes ?? []),
  );
  const auth = new FakeAuth(
    opts.rules ?? [
      { subject: "ops@team", scopes: new Set([SCOPE]) },
    ],
  );
  return mountOpsApi({
    scopeResolver: resolver,
    auth,
    stubFor: (resolved) =>
      resolved.surface === "agent-do/v0.3" ? fakeDO : null,
  });
};

const get = (
  handler: (req: Request) => Promise<Response>,
  path: string,
  init: { principal?: string; lastEventId?: string } = {},
): Promise<Response> => {
  const headers = new Headers();
  if (init.principal !== undefined) {
    headers.set("x-test-principal", init.principal);
  }
  if (init.lastEventId !== undefined) {
    headers.set("last-event-id", init.lastEventId);
  }
  return handler(
    new Request(`https://ops.test${path}`, { method: "GET", headers }),
  );
};

// ============================================================
// Acceptance §6.1 — no app noun
// (Grep is the source-tree assertion; we encode it as a structural test
// over the package barrel + its declared exports.)
// ============================================================

describe("§6.1 ops-api source contains no app nouns", () => {
  it("barrel exports only substrate vocabulary", async () => {
    const barrel = await import("../src");
    const names = Object.keys(barrel);
    const forbidden = ["change", "lead", "site", "schema", "customer", "order"];
    for (const name of names) {
      const lc = name.toLowerCase();
      for (const banned of forbidden) {
        expect(lc).not.toContain(banned);
      }
    }
  });
});

// ============================================================
// Acceptance §6.2 — endpoints map 1:1 to RPC
// (Structural: each endpoint we hit triggers exactly one RPC call.)
// ============================================================

describe("§6.2 endpoints map 1:1 to AgentDOBase RPC", () => {
  it("/events hits events() once", async () => {
    let calls = 0;
    const fakeDO = new FakeAgentDO(ROWS);
    const origEvents = fakeDO.events.bind(fakeDO);
    fakeDO.events = (opts) => {
      calls += 1;
      return origEvents(opts);
    };
    const handler = mountOpsApi({
      scopeResolver: new FakeResolver(
        new Map([[SCOPE, { scope: SCOPE, surface: "agent-do/v0.3" }]]),
      ),
      auth: new FakeAuth([{ subject: "x", scopes: new Set([SCOPE]) }]),
      stubFor: () => fakeDO,
    });
    const res = await get(
      handler,
      `/__ops/api/scopes/${encodeURIComponent(SCOPE)}/events?limit=10`,
      { principal: "x" },
    );
    expect(res.status).toBe(200);
    expect(calls).toBe(1);
  });
});

// ============================================================
// Acceptance §6.3 — OpsAuth mandatory
// ============================================================

describe("§6.3 OpsAuth is mandatory", () => {
  it("mountOpsApi without auth throws at construction", () => {
    const missingAuth = {
      scopeResolver: new FakeResolver(new Map()),
    } as unknown as MountOpsApiOptions;
    expect(() => mountOpsApi(missingAuth)).toThrow(/auth is required/);
  });

  it("mountOpsApi without scopeResolver throws at construction", () => {
    const missingResolver = {
      auth: new FakeAuth([]),
    } as unknown as MountOpsApiOptions;
    expect(() => mountOpsApi(missingResolver)).toThrow(
      /scopeResolver is required/,
    );
  });

  it("missing principal returns 401, never 200", async () => {
    const handler = makeHandler();
    const res = await get(handler, "/__ops/api/scopes");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unauthenticated");
  });
});

// ============================================================
// Acceptance §6.4 — scope unknown 404, opaque 501
// ============================================================

describe("§6.4 scope unknown 404 + opaque 501", () => {
  it("unknown scope returns 404 scope_not_found", async () => {
    const handler = makeHandler({ rules: [{ subject: "x", scopes: new Set() }] });
    const res = await get(
      handler,
      "/__ops/api/scopes/thread%2Fdoesnotexist/events",
      { principal: "x" },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("scope_not_found");
  });

  it("opaque scope returns 501 not_introspectable on each introspection endpoint", async () => {
    const opaque = "sandbox/sbx-1";
    const handler = makeHandler({
      opaqueScopes: [opaque],
      rules: [{ subject: "x", scopes: new Set([opaque]) }],
    });
    const paths = [
      `/__ops/api/scopes/${encodeURIComponent(opaque)}/events`,
      `/__ops/api/scopes/${encodeURIComponent(opaque)}/runs`,
      `/__ops/api/scopes/${encodeURIComponent(opaque)}/runs/1/trace`,
      `/__ops/api/scopes/${encodeURIComponent(opaque)}/runs/1/status`,
      `/__ops/api/scopes/${encodeURIComponent(opaque)}/quota?key=k&windowMs=1000&limit=10`,
      `/__ops/api/scopes/${encodeURIComponent(opaque)}/resource?key=k`,
    ];
    for (const path of paths) {
      const res = await get(handler, path, { principal: "x" });
      expect(res.status).toBe(501);
    }
  });

  it("opaque scope still appears in /scopes index", async () => {
    const opaque = "sandbox/sbx-1";
    const handler = makeHandler({
      opaqueScopes: [opaque],
      rules: [{ subject: "x", scopes: new Set([SCOPE, opaque]) }],
    });
    const res = await get(handler, "/__ops/api/scopes", { principal: "x" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scopes: ScopeSummary[] };
    const surfaces = body.scopes.map((s) => s.surface);
    expect(surfaces).toContain("opaque");
  });
});

// ============================================================
// Acceptance §6.5 — events pagination gap-free over 3 steps
// ============================================================

describe("§6.5 events pagination is gap-free and duplicate-free", () => {
  it("page-by-3 over 8 rows reconstructs the full ledger exactly", async () => {
    const handler = makeHandler();
    const seen: LedgerEventRpc[] = [];
    let afterId = 0;
    for (let step = 0; step < 5; step++) {
      const res = await get(
        handler,
        `/__ops/api/scopes/${encodeURIComponent(SCOPE)}/events?afterId=${afterId}&limit=3`,
        { principal: "ops@team" },
      );
      expect(res.status).toBe(200);
      const page = (await res.json()) as LedgerEventRpc[];
      if (page.length === 0) break;
      // ids must be strictly ascending within and across pages
      for (const r of page) {
        expect(r.id).toBeGreaterThan(afterId);
        afterId = r.id;
      }
      seen.push(...page);
    }
    expect(seen.map((r) => r.id)).toEqual(ROWS.map((r) => r.id));
    // No duplicates
    expect(new Set(seen.map((r) => r.id)).size).toBe(seen.length);
  });
});

// ============================================================
// Acceptance §6.6 — stream reconnect via Last-Event-ID
// ============================================================

describe("§6.6 stream Last-Event-ID reconnect", () => {
  it("server resumes at afterId derived from Last-Event-ID header", async () => {
    const handler = makeHandler();
    const res = await get(
      handler,
      `/__ops/api/scopes/${encodeURIComponent(SCOPE)}/stream`,
      { principal: "ops@team", lastEventId: "4" },
    );
    expect(res.status).toBe(200);
    // Fake stub echoes the afterId via header for test observability.
    expect(res.headers.get("x-ops-test-resumed-from")).toBe("4");
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const body = await res.text();
    // Should contain rows with id > 4 (5..8 from fixture, capped at 2 by stub).
    expect(body).toContain("\nid: 5\n");
    expect(body).not.toContain("\nid: 4\n");
  });

  it("stream action requires authorize(stream); 403 if only read granted", async () => {
    const handler = makeHandler({
      rules: [{ subject: "x", scopes: new Set([SCOPE]), streamScopes: new Set() }],
    });
    const res = await get(
      handler,
      `/__ops/api/scopes/${encodeURIComponent(SCOPE)}/stream`,
      { principal: "x" },
    );
    expect(res.status).toBe(403);
  });
});

// ============================================================
// Acceptance §6.7 — AttemptKey roundtrip
// ============================================================

describe("§6.7 AttemptKey base64url JSON roundtrip", () => {
  it("encodes then decodes to the same shape", () => {
    const key: AttemptKey = {
      routeFingerprint: "openai-chat:gpt-5:a1b2",
      schemaFingerprint: "order_v3:b8c4",
      strategy: "forced-tool-call",
      adapterVersion: "1.2.0",
    };
    const encoded = encodeAttemptKey(key);
    expect(encoded).not.toContain("=");
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    const decoded = decodeAttemptKey(encoded);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.key).toEqual(key);
    }
  });

  it("rejects malformed base64url", () => {
    const decoded = decodeAttemptKey("not!valid!base64");
    expect(decoded.ok).toBe(false);
  });

  it("rejects missing fields", () => {
    const partial = btoa(JSON.stringify({ routeFingerprint: "r" }))
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    const decoded = decodeAttemptKey(partial);
    expect(decoded.ok).toBe(false);
  });

  it("/admission rejects malformed key with 400 not 200", async () => {
    const handler = makeHandler();
    const res = await get(
      handler,
      `/__ops/api/scopes/${encodeURIComponent(SCOPE)}/admission?key=not!valid`,
      { principal: "ops@team" },
    );
    expect(res.status).toBe(400);
  });
});

// ============================================================
// Acceptance §6.8 — /scopes per-principal filter
// ============================================================

describe("§6.8 /scopes filters by principal authorize(read)", () => {
  it("principal a sees scope set A, principal b sees set B", async () => {
    const sA = "thread/a-1";
    const sB = "thread/b-1";
    const sC = "thread/c-1";
    const handler = makeHandler({
      extraScopes: [sA, sB, sC],
      rules: [
        { subject: "a", scopes: new Set([sA, sB]) },
        { subject: "b", scopes: new Set([sC]) },
      ],
    });
    const resA = await get(handler, "/__ops/api/scopes", { principal: "a" });
    const bodyA = (await resA.json()) as { scopes: ScopeSummary[] };
    const seenA = new Set(bodyA.scopes.map((s) => s.scope));
    expect(seenA).toEqual(new Set([sA, sB]));

    const resB = await get(handler, "/__ops/api/scopes", { principal: "b" });
    const bodyB = (await resB.json()) as { scopes: ScopeSummary[] };
    const seenB = new Set(bodyB.scopes.map((s) => s.scope));
    expect(seenB).toEqual(new Set([sC]));
  });
});

// ============================================================
// Acceptance §6.9 — method-not-allowed on non-GET
// ============================================================

describe("§6.9 only GET is allowed", () => {
  it.each(["POST", "PUT", "DELETE", "PATCH"])("%s returns 405", async (m: string) => {
    const handler = makeHandler();
    const res = await handler(
      new Request("https://ops.test/__ops/api/scopes", {
        method: m,
        headers: { "x-test-principal": "ops@team" },
      }),
    );
    expect(res.status).toBe(405);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("method_not_allowed");
  });
});

// ============================================================
// Acceptance §2.4 — /runs list projection from agent.run.* events
// ============================================================

describe("§2.4 /runs lists RunSummary projected from run-bearing kinds", () => {
  it("returns runs sorted by runId DESC with correct status", async () => {
    const handler = makeHandler();
    const res = await get(
      handler,
      `/__ops/api/scopes/${encodeURIComponent(SCOPE)}/runs?limit=10`,
      { principal: "ops@team" },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      runs: { runId: number; status: RunStatus }[];
    };
    expect(body.runs.map((r) => r.runId)).toEqual([8, 6, 1]);
    expect(body.runs[0]!.status.kind).toBe("open_without_terminal");
    expect(body.runs[1]!.status.kind).toBe("aborted");
    expect(body.runs[2]!.status.kind).toBe("delivered");
  });

  it("filters by status=aborted only", async () => {
    const handler = makeHandler();
    const res = await get(
      handler,
      `/__ops/api/scopes/${encodeURIComponent(SCOPE)}/runs?status=aborted`,
      { principal: "ops@team" },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      runs: { runId: number; status: RunStatus }[];
    };
    expect(body.runs.map((r) => r.runId)).toEqual([6]);
  });

  it("paginates by afterRunId descending without gaps or duplicates", async () => {
    const handler = makeHandler();
    const all: number[] = [];
    let afterRunId: number | null = null;
    for (let step = 0; step < 5; step++) {
      const qs =
        afterRunId === null
          ? "?limit=1"
          : `?limit=1&afterRunId=${afterRunId}`;
      const res = await get(
        handler,
        `/__ops/api/scopes/${encodeURIComponent(SCOPE)}/runs${qs}`,
        { principal: "ops@team" },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        runs: { runId: number }[];
        nextCursor: number | null;
      };
      if (body.runs.length === 0) break;
      all.push(...body.runs.map((r) => r.runId));
      if (body.nextCursor === null) break;
      afterRunId = body.nextCursor;
    }
    expect(all).toEqual([8, 6, 1]);
    expect(new Set(all).size).toBe(all.length);
  });
});
