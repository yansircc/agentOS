import { apiGetJson, encodedScopeTail } from "./client";
import { methodNotAllowed, notFound, textResponse } from "./html";
import {
  chooseInitialRun,
  chooseInitialScope,
  renderEventsWorkspace,
  renderRunsPanel,
  renderScopeWorkspace,
  renderScopesPanel,
  renderSelectRunOob,
  renderSelectScopeOob,
  renderShell,
  renderTelemetryWorkspace,
  renderTraceWorkspace,
  scopeRunsTail,
} from "./render";
import type {
  CapabilityLease,
  LedgerEventRpc,
  MountOpsHtmxOptions,
  NormalizedOpsHtmxOptions,
  QuotaState,
  ResourceState,
  RunListPage,
  RunStatus,
  RunTrace,
  ScopeListBody,
  ScopeSummary,
} from "./types";

type WorkspaceTab = "overview" | "trace" | "events" | "telemetry";

const DEFAULT_HTMX = "https://unpkg.com/htmx.org@2.0.4";

const normalizeBase = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "/";
  const withLead = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLead.length > 1 ? withLead.replace(/\/+$/g, "") : withLead;
};

const normalizeOptions = (opts: MountOpsHtmxOptions): NormalizedOpsHtmxOptions => {
  if (opts.apiFetch === undefined || opts.apiFetch === null) {
    throw new Error("@agent-os/ops-htmx: apiFetch is required");
  }
  return {
    apiFetch: opts.apiFetch,
    uiBase: normalizeBase(opts.uiBase ?? "/__ops"),
    apiBase: normalizeBase(opts.apiBase ?? "/__ops/api"),
    title: opts.title ?? "@agent-os/ops",
    htmxScriptSrc: opts.htmxScriptSrc === undefined ? DEFAULT_HTMX : opts.htmxScriptSrc,
    runLimit: opts.runLimit ?? 50,
    eventLimit: opts.eventLimit ?? 100,
  };
};

export const mountOpsHtmx = (
  options: MountOpsHtmxOptions,
): ((req: Request) => Promise<Response>) => {
  const opts = normalizeOptions(options);
  return (req) => handle(opts, req);
};

export const isOpsHtmxPath = (url: URL, uiBase = "/__ops"): boolean => {
  const base = normalizeBase(uiBase);
  return (
    url.pathname === base ||
    url.pathname === `${base}/` ||
    url.pathname.startsWith(`${base}/fragments/`)
  );
};

const handle = async (opts: NormalizedOpsHtmxOptions, req: Request): Promise<Response> => {
  const url = new URL(req.url);
  if (!isOpsHtmxPath(url, opts.uiBase)) return notFound();
  if (req.method !== "GET") return methodNotAllowed();

  const tail = url.pathname === opts.uiBase ? "/" : url.pathname.slice(opts.uiBase.length);

  if (tail === "/" || tail === "") return textResponse(await shell(opts, req, url));
  if (tail === "/fragments/scopes") {
    return textResponse(await scopesFragment(opts, req, url));
  }
  if (tail === "/fragments/runs") {
    return textResponse(await runsFragment(opts, req, url));
  }
  if (tail === "/fragments/select-scope") {
    return textResponse(await selectScopeFragment(opts, req, url));
  }
  if (tail === "/fragments/select-run") {
    return textResponse(await selectRunFragment(opts, req, url));
  }
  if (tail === "/fragments/events") {
    return textResponse(await eventsFragment(opts, req, url));
  }
  if (tail === "/fragments/telemetry") {
    return textResponse(await telemetryFragment(opts, req, url));
  }
  return notFound();
};

const loadScopes = async (opts: NormalizedOpsHtmxOptions, req: Request, prefix?: string) =>
  apiGetJson<ScopeListBody>(opts, req, "scopes", {
    ...(prefix === undefined || prefix.length === 0 ? {} : { prefix }),
    limit: 1000,
  });

const loadRuns = async (
  opts: NormalizedOpsHtmxOptions,
  req: Request,
  scope: string,
  params: {
    readonly status?: string;
    readonly afterRunId?: string;
  } = {},
) =>
  apiGetJson<RunListPage>(opts, req, scopeRunsTail(scope), {
    limit: opts.runLimit,
    status: params.status,
    afterRunId: params.afterRunId,
  });

const shell = async (opts: NormalizedOpsHtmxOptions, req: Request, url: URL): Promise<string> => {
  const scopes = await loadScopes(opts, req);
  const selected = scopes.ok
    ? chooseInitialScope(scopes.value.scopes, url.searchParams.get("scope"))
    : undefined;
  const runs =
    selected?.surface === "agent-do/v0.3" ? await loadRuns(opts, req, selected.scope) : null;
  const selectedRun =
    runs?.ok === true ? chooseInitialRun(runs.value, url.searchParams.get("runId")) : undefined;
  const tab = parseWorkspaceTab(url.searchParams.get("tab"));
  const workspace = await workspaceForSelection(opts, req, selected, selectedRun?.runId, tab, url);
  return renderShell(opts, {
    scopes: renderScopesPanel(opts, scopes, selected?.scope),
    runs: renderRunsPanel(opts, selected?.scope, runs, selectedRun?.runId),
    workspace,
  });
};

const scopesFragment = async (
  opts: NormalizedOpsHtmxOptions,
  req: Request,
  url: URL,
): Promise<string> => {
  const prefix = url.searchParams.get("prefix") ?? "";
  const selectedScope = url.searchParams.get("scope") ?? undefined;
  const scopes = await loadScopes(opts, req, prefix);
  return renderScopesPanel(opts, scopes, selectedScope, prefix);
};

const runsFragment = async (
  opts: NormalizedOpsHtmxOptions,
  req: Request,
  url: URL,
): Promise<string> => {
  const scope = url.searchParams.get("scope") ?? undefined;
  if (scope === undefined || scope.length === 0) {
    return renderRunsPanel(opts, undefined, null);
  }
  const runs = await loadRuns(opts, req, scope, {
    status: url.searchParams.get("status") ?? undefined,
    afterRunId: url.searchParams.get("afterRunId") ?? undefined,
  });
  return renderRunsPanel(opts, scope, runs);
};

const selectScopeFragment = async (
  opts: NormalizedOpsHtmxOptions,
  req: Request,
  url: URL,
): Promise<string> => {
  const scope = url.searchParams.get("scope") ?? "";
  const prefix = url.searchParams.get("prefix") ?? "";
  const scopes = await loadScopes(opts, req, prefix);
  const selected = scopes.ok
    ? scopes.value.scopes.find((entry) => entry.scope === scope)
    : undefined;
  const runs =
    selected?.surface === "agent-do/v0.3" ? await loadRuns(opts, req, selected.scope) : null;
  const selectedRun = runs?.ok === true ? chooseInitialRun(runs.value, null) : undefined;
  const workspace =
    selected !== undefined && selected.surface === "agent-do/v0.3" && selectedRun !== undefined
      ? await traceWorkspace(opts, req, selected.scope, selectedRun.runId)
      : renderScopeWorkspace(opts, scope, selected);
  return renderSelectScopeOob({
    scopes: renderScopesPanel(opts, scopes, scope, prefix),
    runs: renderRunsPanel(opts, selected?.scope ?? scope, runs, selectedRun?.runId),
    workspace,
  });
};

const selectRunFragment = async (
  opts: NormalizedOpsHtmxOptions,
  req: Request,
  url: URL,
): Promise<string> => {
  const scope = url.searchParams.get("scope") ?? "";
  const runId = Number(url.searchParams.get("runId") ?? 0);
  const runs = await loadRuns(opts, req, scope);
  return renderSelectRunOob({
    runs: renderRunsPanel(opts, scope, runs, runId),
    workspace: await traceWorkspace(opts, req, scope, runId),
  });
};

const traceWorkspace = async (
  opts: NormalizedOpsHtmxOptions,
  req: Request,
  scope: string,
  runId: number,
): Promise<string> => {
  const [trace, status] = await Promise.all([
    apiGetJson<RunTrace>(opts, req, encodedScopeTail(scope, `runs/${runId}/trace`)),
    apiGetJson<RunStatus>(opts, req, encodedScopeTail(scope, `runs/${runId}/status`)),
  ]);
  return renderTraceWorkspace(opts, scope, runId, trace, status);
};

const workspaceForSelection = async (
  opts: NormalizedOpsHtmxOptions,
  req: Request,
  selected: ScopeSummary | undefined,
  runId: number | undefined,
  tab: WorkspaceTab | undefined,
  url: URL,
): Promise<string> => {
  if (selected === undefined || selected.surface !== "agent-do/v0.3") {
    return renderScopeWorkspace(opts, selected?.scope, selected);
  }
  const active = tab ?? (runId === undefined ? "overview" : "trace");
  if (active === "events") {
    return eventsWorkspace(opts, req, url, selected.scope, runId);
  }
  if (active === "telemetry") {
    return telemetryWorkspace(opts, req, url, selected.scope, runId);
  }
  if (runId !== undefined) {
    return traceWorkspace(opts, req, selected.scope, runId);
  }
  return renderScopeWorkspace(opts, selected.scope, selected);
};

const parseWorkspaceTab = (raw: string | null): WorkspaceTab | undefined =>
  raw === "overview" || raw === "trace" || raw === "events" || raw === "telemetry"
    ? raw
    : undefined;

const eventsFragment = async (
  opts: NormalizedOpsHtmxOptions,
  req: Request,
  url: URL,
): Promise<string> => {
  const scope = url.searchParams.get("scope") ?? "";
  const runId = positiveInt(url.searchParams.get("runId"), 0);
  return eventsWorkspace(opts, req, url, scope, runId === 0 ? undefined : runId);
};

const eventsWorkspace = async (
  opts: NormalizedOpsHtmxOptions,
  req: Request,
  url: URL,
  scope: string,
  runId: number | undefined,
): Promise<string> => {
  const limit = positiveInt(url.searchParams.get("limit"), opts.eventLimit);
  const afterId = nonNegativeInt(url.searchParams.get("afterId"));
  const kinds = url.searchParams.get("kinds") ?? undefined;
  const result = await apiGetJson<ReadonlyArray<LedgerEventRpc>>(
    opts,
    req,
    encodedScopeTail(scope, "events"),
    {
      limit,
      afterId,
      kinds: kinds === "" ? undefined : kinds,
    },
  );
  return renderEventsWorkspace(opts, scope, runId, result, {
    limit,
    ...(afterId === undefined ? {} : { afterId }),
    ...(kinds === undefined || kinds === "" ? {} : { kinds }),
  });
};

const telemetryFragment = async (
  opts: NormalizedOpsHtmxOptions,
  req: Request,
  url: URL,
): Promise<string> => {
  const scope = url.searchParams.get("scope") ?? "";
  const runId = positiveInt(url.searchParams.get("runId"), 0);
  return telemetryWorkspace(opts, req, url, scope, runId === 0 ? undefined : runId);
};

const telemetryWorkspace = async (
  opts: NormalizedOpsHtmxOptions,
  req: Request,
  url: URL,
  scope: string,
  runId: number | undefined,
): Promise<string> => {
  const quotaKey = url.searchParams.get("quotaKey") ?? undefined;
  const windowMs = url.searchParams.get("windowMs") ?? undefined;
  const quotaLimit = url.searchParams.get("quotaLimit") ?? undefined;
  const resourceKey = url.searchParams.get("resourceKey") ?? undefined;
  const admissionKey = url.searchParams.get("admissionKey") ?? undefined;

  const [quota, resource, admission] = await Promise.all([
    quotaKey === undefined || quotaKey.length === 0
      ? Promise.resolve(undefined)
      : apiGetJson<QuotaState>(opts, req, encodedScopeTail(scope, "quota"), {
          key: quotaKey,
          windowMs: windowMs ?? "Infinity",
          limit: quotaLimit ?? "1",
        }),
    resourceKey === undefined || resourceKey.length === 0
      ? Promise.resolve(undefined)
      : apiGetJson<ResourceState>(opts, req, encodedScopeTail(scope, "resource"), {
          key: resourceKey,
        }),
    admissionKey === undefined || admissionKey.length === 0
      ? Promise.resolve(undefined)
      : apiGetJson<CapabilityLease | null>(opts, req, encodedScopeTail(scope, "admission"), {
          key: admissionKey,
        }),
  ]);

  return renderTelemetryWorkspace(
    opts,
    scope,
    runId,
    { quota, resource, admission },
    { quotaKey, windowMs, quotaLimit, resourceKey, admissionKey },
  );
};

const positiveInt = (raw: string | null, fallback: number): number => {
  if (raw === null || !/^\d+$/.test(raw)) return fallback;
  const parsed = Number(raw);
  return parsed > 0 ? parsed : fallback;
};

const nonNegativeInt = (raw: string | null): number | undefined => {
  if (raw === null || !/^\d+$/.test(raw)) return undefined;
  return Number(raw);
};
