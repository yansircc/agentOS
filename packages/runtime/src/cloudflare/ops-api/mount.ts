/**
 * @agent-os/runtime/cloudflare/ops-api — Worker fetch handler.
 *
 * mountOpsApi(opts) -> (req: Request) => Promise<Response>
 *
 * Routes all /__ops/api/* paths. Returns 405 for non-GET methods.
 * Auth, scope resolution, and opaque-surface gating all run before RPC dispatch.
 * The reader adapter is supplied by the backend package; ops-api never casts a
 * Durable Object stub or chooses a ledger identity.
 */

import type { AttemptKey, CapabilityLease } from "@agent-os/core/runtime-protocol";
import type {
  EventQueryOptions,
  LedgerEventRpc,
  QuotaState,
  ResourceState,
  RunListPage,
  RunListSpec,
  RunStatus,
  RunStatusKind,
  RunTrace,
  StreamEventsOptions,
} from "@agent-os/core/types";

import { decodeAttemptKey } from "./encoding";
import { jsonOk, opsError } from "./errors";
import type {
  OpsAction,
  OpsAuth,
  OpsPrincipal,
  ResolvedScope,
  ScopeResolver,
  ScopeSummary,
} from "./types";

// ============================================================
// Backend-bound reader surface that ops-api calls. A concrete backend owns the
// ResolvedScope -> identity-bound reader adapter. Test mocks satisfy the same
// interface.
// ============================================================

export interface AgentDOIntrospection {
  events(opts?: EventQueryOptions): Promise<LedgerEventRpc[]>;
  streamEvents(opts: StreamEventsOptions): Response | Promise<Response>;
  runs(spec: RunListSpec): Promise<RunListPage>;
  runTrace(runId: number | string): Promise<RunTrace>;
  runStatus(runId: number | string): Promise<RunStatus>;
  quotaState(spec: { key: string; windowMs: number; limit: number }): Promise<QuotaState>;
  resourceState(key: string): Promise<ResourceState>;
  admissionLease(key: AttemptKey): Promise<CapabilityLease | null>;
}

// ============================================================
// mountOpsApi
// ============================================================

export interface MountOpsApiOptions {
  readonly scopeResolver: ScopeResolver;
  readonly auth: OpsAuth;
  readonly stubFor: (resolved: ResolvedScope) => AgentDOIntrospection | null;
}

const requireOptions = (opts: MountOpsApiOptions): void => {
  if (opts.scopeResolver === undefined || opts.scopeResolver === null) {
    throw new Error("@agent-os/runtime/cloudflare/ops-api: scopeResolver is required");
  }
  if (opts.auth === undefined || opts.auth === null) {
    throw new Error("@agent-os/runtime/cloudflare/ops-api: auth is required");
  }
  if (opts.stubFor === undefined || opts.stubFor === null) {
    throw new Error("@agent-os/runtime/cloudflare/ops-api: stubFor is required");
  }
};

export const mountOpsApi = (opts: MountOpsApiOptions): ((req: Request) => Promise<Response>) => {
  requireOptions(opts);
  return (req) => handle(req, opts, opts.stubFor);
};

// ============================================================
// Top-level dispatch
// ============================================================

const PREFIX = "/__ops/api";

const handle = async (
  req: Request,
  opts: MountOpsApiOptions,
  stubFor: (resolved: ResolvedScope) => AgentDOIntrospection | null,
): Promise<Response> => {
  if (req.method !== "GET") {
    return opsError("method_not_allowed", `${req.method} not allowed`);
  }

  const url = new URL(req.url);
  const path = url.pathname;
  if (!path.startsWith(PREFIX)) {
    return opsError("scope_not_found", "not an ops-api path");
  }

  const tail = path.slice(PREFIX.length);
  // tail patterns:
  //   /scopes
  //   /scopes/:scope/...
  if (tail === "/scopes" || tail === "/scopes/") {
    return await handleScopesIndex(req, url, opts);
  }
  if (!tail.startsWith("/scopes/")) {
    return opsError("scope_not_found", "unknown ops-api path");
  }

  const remainder = tail.slice("/scopes/".length);
  // remainder: <encoded-scope>/<subpath>
  const slash = remainder.indexOf("/");
  if (slash < 0) {
    return opsError("bad_request", "missing scope subpath");
  }
  const encScope = remainder.slice(0, slash);
  const subpath = remainder.slice(slash); // includes leading "/"
  let scope: string;
  try {
    scope = decodeURIComponent(encScope);
  } catch {
    return opsError("bad_request", "malformed scope segment");
  }

  return await handleScopeRoute(req, url, subpath, scope, opts, stubFor);
};

// ============================================================
// /scopes index (contract §2.1, §5.1)
// ============================================================

const handleScopesIndex = async (
  req: Request,
  url: URL,
  opts: MountOpsApiOptions,
): Promise<Response> => {
  const principal = await opts.auth.authenticate(req);
  if (principal === null) return opsError("unauthenticated", "no principal");

  const prefix = url.searchParams.get("prefix") ?? undefined;
  const limitRaw = url.searchParams.get("limit");
  const limit = parseLimit(limitRaw, 100, 1000);
  if (limit === null) {
    return opsError("bad_request", "limit must be a positive integer");
  }

  // v0: no cursor. Resolver returns the full set the principal could
  // possibly see (up to limit); ops-api filters by per-scope authorize(read).
  // If a deployment grows past one page, the resolver should accept the
  // principal and pre-filter — see contract §9 open question.
  const scopes = await opts.scopeResolver.list({
    ...(prefix !== undefined ? { prefix } : {}),
    limit,
  });

  const filtered: ScopeSummary[] = [];
  for (const summary of scopes) {
    if (await opts.auth.authorize(principal, summary.scope, "read")) {
      filtered.push(summary);
    }
  }

  return jsonOk({ scopes: filtered });
};

// ============================================================
// /scopes/:scope/* dispatch (contract §2.2–§2.9, §5)
// ============================================================

const handleScopeRoute = async (
  req: Request,
  url: URL,
  subpath: string,
  scope: string,
  opts: MountOpsApiOptions,
  stubFor: (resolved: ResolvedScope) => AgentDOIntrospection | null,
): Promise<Response> => {
  const principal = await opts.auth.authenticate(req);
  if (principal === null) return opsError("unauthenticated", "no principal");

  const resolved = await opts.scopeResolver.resolve(scope);
  if (resolved === null) {
    return opsError("scope_not_found", `scope not found: ${scope}`);
  }

  const action: OpsAction = subpath === "/stream" ? "stream" : "read";
  const permitted = await opts.auth.authorize(principal, scope, action);
  if (!permitted) {
    return opsError("forbidden", `not authorized: ${action} ${scope}`);
  }

  if (resolved.surface !== "agent-do/v0.3") {
    return opsError("not_introspectable", `scope is ${resolved.surface}`);
  }

  const stub = stubFor(resolved);
  if (stub === null) {
    return opsError("upstream_failure", "no stub for resolved scope");
  }

  return await dispatchScopeEndpoint(req, url, subpath, scope, stub, principal);
};

const dispatchScopeEndpoint = async (
  req: Request,
  url: URL,
  subpath: string,
  scope: string,
  stub: AgentDOIntrospection,
  _principal: OpsPrincipal,
): Promise<Response> => {
  if (subpath === "/events") return await onEvents(url, stub);
  if (subpath === "/stream") return await onStream(req, url, stub);
  if (subpath === "/runs") return await onRunsList(url, stub);
  if (subpath === "/quota") return await onQuota(url, stub);
  if (subpath === "/resource") return await onResource(url, stub);
  if (subpath === "/admission") return await onAdmission(url, stub);

  // /runs/:runId/(trace|status)
  const runMatch = subpath.match(/^\/runs\/([^/]+)\/(trace|status)$/);
  if (runMatch !== null) {
    const runId = parseInt(runMatch[1]!, 10);
    if (!Number.isInteger(runId) || runId < 1) {
      return opsError("bad_request", "runId must be a positive integer");
    }
    return runMatch[2] === "trace"
      ? await onRunTrace(stub, runId, scope)
      : await onRunStatus(stub, runId, scope);
  }

  return opsError("scope_not_found", `unknown endpoint: ${subpath}`);
};

// ============================================================
// Endpoint handlers
// ============================================================

const onEvents = async (url: URL, stub: AgentDOIntrospection): Promise<Response> => {
  const afterId = parseOptionalNonNegInt(url.searchParams.get("afterId"));
  if (afterId === "invalid") {
    return opsError("bad_request", "afterId must be a non-negative integer");
  }
  const limit = parseLimit(url.searchParams.get("limit"), 1000, 10000);
  if (limit === null) {
    return opsError("bad_request", "limit must be a positive integer");
  }
  const kinds = parseKinds(url.searchParams.get("kinds"));

  const queryOpts: EventQueryOptions = {
    limit,
    ...(afterId !== undefined ? { afterId } : {}),
    ...(kinds !== undefined ? { kinds } : {}),
  };
  try {
    const rows = await stub.events(queryOpts);
    return jsonOk(rows);
  } catch (e) {
    return opsError("upstream_failure", String((e as Error)?.message ?? e));
  }
};

const onStream = async (req: Request, url: URL, stub: AgentDOIntrospection): Promise<Response> => {
  // Worker-side Last-Event-ID parsing per contract §2.3.
  const headerCursor = req.headers.get("last-event-id");
  const headerAfterId =
    headerCursor !== null && /^\d+$/.test(headerCursor) ? parseInt(headerCursor, 10) : undefined;
  const queryAfterId = parseOptionalNonNegInt(url.searchParams.get("afterId"));
  if (queryAfterId === "invalid") {
    return opsError("bad_request", "afterId must be a non-negative integer");
  }
  const afterId = headerAfterId ?? (queryAfterId as number | undefined);
  const kinds = parseKinds(url.searchParams.get("kinds"));
  const heartbeatRaw = url.searchParams.get("heartbeatMs");
  const heartbeatMs =
    heartbeatRaw !== null && /^\d+$/.test(heartbeatRaw) ? parseInt(heartbeatRaw, 10) : undefined;

  const streamOpts: StreamEventsOptions = {
    ...(afterId !== undefined ? { afterId } : {}),
    ...(kinds !== undefined ? { kinds } : {}),
    ...(heartbeatMs !== undefined ? { heartbeatMs } : {}),
  };
  try {
    const response = await stub.streamEvents(streamOpts);
    return response;
  } catch (e) {
    return opsError("upstream_failure", String((e as Error)?.message ?? e));
  }
};

const onRunsList = async (url: URL, stub: AgentDOIntrospection): Promise<Response> => {
  const statusRaw = url.searchParams.get("status");
  let statuses: ReadonlyArray<RunStatusKind> | undefined;
  if (statusRaw !== null) {
    const parts = statusRaw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const s of parts) {
      if (
        s !== "delivered" &&
        s !== "aborted" &&
        s !== "open_without_terminal" &&
        s !== "orphaned"
      ) {
        return opsError("bad_request", `unknown status: ${s}`);
      }
    }
    statuses = parts as ReadonlyArray<RunStatusKind>;
  }

  const afterRunId = parseOptionalNonNegInt(url.searchParams.get("afterRunId"));
  if (afterRunId === "invalid") {
    return opsError("bad_request", "afterRunId must be a non-negative integer");
  }
  const limit = parseLimit(url.searchParams.get("limit"), 50, 500);
  if (limit === null) {
    return opsError("bad_request", "limit must be a positive integer");
  }

  // /runs is a 1:1 RPC mapping to Cloudflare backend.runs — projection lives in runtime.
  // ops-api does no local fetch+project; the DO walks its own ledger.
  const spec: RunListSpec = {
    limit,
    ...(statuses !== undefined ? { statuses } : {}),
    ...(afterRunId !== undefined ? { afterRunId: afterRunId as number } : {}),
  };
  try {
    const page = await stub.runs(spec);
    return jsonOk(page);
  } catch (e) {
    return opsError("upstream_failure", String((e as Error)?.message ?? e));
  }
};

const onRunTrace = async (
  stub: AgentDOIntrospection,
  runId: number,
  _scope: string,
): Promise<Response> => {
  try {
    const trace = await stub.runTrace(runId);
    if (trace.startedAt === 0) {
      return opsError("run_not_found", `run ${runId} not found`);
    }
    return jsonOk(trace);
  } catch (e) {
    return opsError("upstream_failure", String((e as Error)?.message ?? e));
  }
};

const onRunStatus = async (
  stub: AgentDOIntrospection,
  runId: number,
  _scope: string,
): Promise<Response> => {
  try {
    const status = await stub.runStatus(runId);
    if (status.kind === "orphaned" && status.startedAt === 0) {
      return opsError("run_not_found", `run ${runId} not found`);
    }
    return jsonOk(status);
  } catch (e) {
    return opsError("upstream_failure", String((e as Error)?.message ?? e));
  }
};

const onQuota = async (url: URL, stub: AgentDOIntrospection): Promise<Response> => {
  const key = url.searchParams.get("key");
  const windowMsRaw = url.searchParams.get("windowMs");
  const limitRaw = url.searchParams.get("limit");
  if (key === null || windowMsRaw === null || limitRaw === null) {
    return opsError("bad_request", "quota requires key, windowMs, limit query params");
  }
  const windowMs =
    windowMsRaw === "Infinity" ? Number.POSITIVE_INFINITY : parseInt(windowMsRaw, 10);
  const limit = parseInt(limitRaw, 10);
  if (!Number.isInteger(limit) || limit < 1) {
    return opsError("bad_request", "limit must be an integer >= 1");
  }
  if (windowMs !== Number.POSITIVE_INFINITY) {
    if (!Number.isInteger(windowMs) || windowMs <= 0) {
      return opsError("bad_request", "windowMs must be a positive integer or 'Infinity'");
    }
  }
  try {
    const state = await stub.quotaState({ key, windowMs, limit });
    return jsonOk(state);
  } catch (e) {
    return opsError("upstream_failure", String((e as Error)?.message ?? e));
  }
};

const onResource = async (url: URL, stub: AgentDOIntrospection): Promise<Response> => {
  const key = url.searchParams.get("key");
  if (key === null || key.length === 0) {
    return opsError("bad_request", "resource requires key query param");
  }
  try {
    const state = await stub.resourceState(key);
    return jsonOk(state);
  } catch (e) {
    return opsError("upstream_failure", String((e as Error)?.message ?? e));
  }
};

const onAdmission = async (url: URL, stub: AgentDOIntrospection): Promise<Response> => {
  const keyParam = url.searchParams.get("key");
  if (keyParam === null) {
    return opsError(
      "bad_request",
      "admission requires base64url(JSON(AttemptKey)) key query param",
    );
  }
  const decoded = decodeAttemptKey(keyParam);
  if (!decoded.ok) {
    return opsError("bad_request", `admission key ${decoded.reason}`);
  }
  try {
    const lease = await stub.admissionLease(decoded.key);
    return jsonOk(lease);
  } catch (e) {
    return opsError("upstream_failure", String((e as Error)?.message ?? e));
  }
};

// ============================================================
// Query parser helpers
// ============================================================

const parseLimit = (raw: string | null, fallback: number, cap: number): number | null => {
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw)) return null;
  const n = parseInt(raw, 10);
  if (n <= 0) return null;
  return Math.min(n, cap);
};

const parseOptionalNonNegInt = (raw: string | null): number | undefined | "invalid" => {
  if (raw === null) return undefined;
  if (!/^\d+$/.test(raw)) return "invalid";
  return parseInt(raw, 10);
};

const parseKinds = (raw: string | null): ReadonlyArray<string> | undefined => {
  if (raw === null || raw.length === 0) return undefined;
  const kinds = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return kinds.length === 0 ? undefined : kinds;
};
