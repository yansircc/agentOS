import { encodedScopeTail, uiPath } from "./client";
import {
  compactJson,
  escapeAttr,
  escapeHtml,
  prettyJson,
} from "./html";
import type {
  ApiResult,
  CapabilityLease,
  LedgerEventRpc,
  NormalizedOpsHtmxOptions,
  QuotaState,
  ResourceState,
  RunListPage,
  RunStatus,
  RunSummary,
  RunTrace,
  ScopeSummary,
} from "./types";

type WorkspaceTab = "overview" | "trace" | "events" | "telemetry";

const statusClass = (status: RunStatus | string): string => {
  const kind = typeof status === "string" ? status : status.kind;
  return kind === "open_without_terminal" ? "open" : kind;
};

const statusLabel = (status: RunStatus | string): string => {
  const kind = typeof status === "string" ? status : status.kind;
  return kind === "open_without_terminal" ? "open" : kind;
};

const fmtTime = (ts: number | undefined): string => {
  if (ts === undefined || ts === 0) return "-";
  return String(ts);
};

const fmtDuration = (ms: number | undefined): string =>
  ms === undefined ? "-" : `${Math.round(ms / 100) / 10}s`;

const errorBlock = (result: ApiResult<unknown>): string =>
  result.ok
    ? ""
    : `<div class="state state-error"><b>${escapeHtml(result.status)}</b><span>${escapeHtml(result.error.error)}</span><small>${escapeHtml(result.error.message)}</small></div>`;

const emptyBlock = (label: string): string =>
  `<div class="state"><b>${escapeHtml(label)}</b><span>empty</span></div>`;

export const renderShell = (
  opts: NormalizedOpsHtmxOptions,
  parts: {
    readonly scopes: string;
    readonly runs: string;
    readonly workspace: string;
  },
): string => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(opts.title)}</title>
  ${opts.htmxScriptSrc === null ? "" : `<script src="${escapeAttr(opts.htmxScriptSrc)}"></script>`}
  <style>${CSS}</style>
</head>
<body>
  <header class="topbar">
    <div class="brand">${escapeHtml(opts.title)} <span>spec-36</span></div>
    <div class="meta"><code>${escapeHtml(opts.apiBase)}</code></div>
  </header>
  <div class="layout">
    <aside id="scopes-panel" class="column scopes-column">${parts.scopes}</aside>
    <aside id="runs-panel" class="column runs-column">${parts.runs}</aside>
    <main id="workspace-panel" class="column workspace">${parts.workspace}</main>
  </div>
  <div id="oob-target" hidden></div>
</body>
</html>`;

export const renderScopesPanel = (
  opts: NormalizedOpsHtmxOptions,
  result: ApiResult<{ readonly scopes: ReadonlyArray<ScopeSummary> }>,
  selectedScope?: string,
  prefix = "",
): string => {
  if (!result.ok) {
    return `<div class="endpoint">GET /__ops/api/scopes</div>${errorBlock(result)}`;
  }
  const scopes = result.value.scopes;
  const rows = scopes
    .map((scope) => {
      const active = scope.scope === selectedScope ? " active" : "";
      const opaque = scope.surface === "opaque" ? " opaque" : "";
      const surface = scope.surface === "agent-do/v0.3" ? "v0.3" : "opaque";
      const shellPath = canonicalShellPath(
        opts,
        scope.scope,
        undefined,
        scope.surface === "agent-do/v0.3" ? "trace" : "overview",
      );
      const fragmentPath = uiPath(opts, "fragments/select-scope", {
        scope: scope.scope,
        prefix,
      });
      return `<a class="scope-row${active}${opaque}" href="${escapeAttr(shellPath)}" hx-get="${escapeAttr(fragmentPath)}" hx-target="#oob-target" hx-swap="innerHTML" hx-push-url="${escapeAttr(shellPath)}">
        <span>${escapeHtml(scope.scope)}</span>
        <span class="surface">${escapeHtml(surface)}</span>
      </a>`;
    })
    .join("");
  return `<div class="endpoint">GET /__ops/api/scopes</div>
    <div class="scopes-list">
      <h3>scopes (${scopes.length})</h3>
      ${rows.length === 0 ? emptyBlock("scopes") : rows}
    </div>
    <form class="filter-container" hx-get="${escapeAttr(uiPath(opts, "fragments/scopes"))}" hx-target="#scopes-panel" hx-swap="innerHTML">
      <h3>filter</h3>
      <input class="filter-input" name="prefix" placeholder="prefix" value="${escapeAttr(prefix)}">
      ${selectedScope === undefined ? "" : `<input type="hidden" name="scope" value="${escapeAttr(selectedScope)}">`}
    </form>`;
};

export const renderRunsPanel = (
  opts: NormalizedOpsHtmxOptions,
  scope: string | undefined,
  result: ApiResult<RunListPage> | null,
  selectedRunId?: number,
): string => {
  if (scope === undefined) {
    return `<div class="header-desc">runs</div>${emptyBlock("scope")}`;
  }
  if (result !== null && !result.ok) {
    return `<div class="header-desc">GET /scopes/:scope/runs</div>${errorBlock(result)}`;
  }
  const page = result?.ok === true ? result.value : { runs: [], nextCursor: null };
  const rows = page.runs
    .map((run) => renderRunRow(opts, scope, run, selectedRunId))
    .join("");
  const next =
    page.nextCursor === null
      ? ""
      : `<a class="pager" hx-get="${escapeAttr(uiPath(opts, "fragments/runs", { scope, afterRunId: page.nextCursor }))}" hx-target="#runs-panel" hx-swap="innerHTML">older than #${escapeHtml(page.nextCursor)}</a>`;
  return `<div class="header-desc">GET /scopes/:scope/runs</div>
    <div class="runs-list">
      <h3>runs history (${page.runs.length})</h3>
      ${rows.length === 0 ? emptyBlock("runs") : rows}
      ${next}
    </div>
    <form class="filter-container" hx-get="${escapeAttr(uiPath(opts, "fragments/runs"))}" hx-target="#runs-panel" hx-swap="innerHTML">
      <h3>status</h3>
      <input type="hidden" name="scope" value="${escapeAttr(scope)}">
      <select class="filter-input" name="status">
        <option value="">all</option>
        <option value="delivered">delivered</option>
        <option value="aborted">aborted</option>
        <option value="open_without_terminal">open</option>
        <option value="orphaned">orphaned</option>
      </select>
    </form>`;
};

const renderRunRow = (
  opts: NormalizedOpsHtmxOptions,
  scope: string,
  run: RunSummary,
  selectedRunId?: number,
): string => {
  const active = run.runId === selectedRunId ? " active" : "";
  const shellPath = canonicalShellPath(opts, scope, run.runId, "trace");
  const fragmentPath = uiPath(opts, "fragments/select-run", {
    scope,
    runId: run.runId,
  });
  return `<a class="run-list-item${active}" href="${escapeAttr(shellPath)}" hx-get="${escapeAttr(fragmentPath)}" hx-target="#oob-target" hx-swap="innerHTML" hx-push-url="${escapeAttr(shellPath)}">
    <div class="run-top">
      <span class="runId">run <b>#${escapeHtml(run.runId)}</b></span>
      <span class="badge ${escapeAttr(statusClass(run.status))}">${escapeHtml(statusLabel(run.status))}</span>
    </div>
    <div class="run-time">${escapeHtml(fmtTime(run.startedAt))} · ${escapeHtml(fmtDuration(run.durationMs))}</div>
  </a>`;
};

export const renderScopeWorkspace = (
  opts: NormalizedOpsHtmxOptions,
  scope: string | undefined,
  selected: ScopeSummary | undefined,
): string => {
  if (scope === undefined) return emptyBlock("scope");
  const opaque = selected?.surface === "opaque";
  return `<div class="scope-header">
      <h2>${escapeHtml(scope)}</h2>
      <div class="scope-meta"><span class="surface-badge">${escapeHtml(selected?.surface ?? "unknown")}</span></div>
    </div>
    ${opaque ? `<div class="state state-error"><b>501</b><span>not_introspectable</span><small>surface=${escapeHtml(selected.surface)}</small></div>` : renderTabs(opts, scope, undefined, "overview")}
    ${opaque ? "" : `<section class="section"><header><h3>scope</h3><span class="endpoint-tag">GET /scopes/:scope/*</span></header><div class="section-body">${kv("scope", scope)}${kv("surface", selected?.surface ?? "unknown")}</div></section>`}`;
};

export const renderTraceWorkspace = (
  opts: NormalizedOpsHtmxOptions,
  scope: string,
  runId: number,
  trace: ApiResult<RunTrace>,
  status: ApiResult<RunStatus>,
): string => `<div class="scope-header">
    <h2>${escapeHtml(scope)}</h2>
    <div class="scope-meta"><span class="surface-badge">agent-do/v0.3</span><span class="mono">run #${escapeHtml(runId)}</span></div>
  </div>
  ${renderTabs(opts, scope, runId, "trace")}
  <section class="section">
    <header><h3>run #${escapeHtml(runId)} trace</h3><span class="endpoint-tag">GET /runs/:runId/trace + /status</span></header>
    <div class="section-body">
      ${!trace.ok ? errorBlock(trace) : !status.ok ? errorBlock(status) : renderTraceBody(trace.value, status.value)}
    </div>
  </section>`;

const renderTraceBody = (trace: RunTrace, status: RunStatus): string => {
  const terminal = trace.terminal;
  const lines = [
    `<div class="trace-line"><span class="ts">${escapeHtml(fmtTime(trace.startedAt))}</span><span class="turn-num">start</span><span class="label">agent.run.started</span><span class="detail">run #${escapeHtml(trace.runId)}</span></div>`,
    ...trace.turns.map(
      (turn) =>
        `<div class="trace-line"><span class="ts">${escapeHtml(fmtTime(turn.at))}</span><span class="turn-num">turn ${escapeHtml(turn.index)}</span><span class="label">llm.response</span><span class="detail">${escapeHtml(turn.text)}</span></div>`,
    ),
    ...trace.toolCalls.map(
      (tool) =>
        `<div class="trace-line"><span class="ts">${escapeHtml(fmtTime(tool.at))}</span><span class="turn-num">tool</span><span class="label">${escapeHtml(tool.name)}</span><span class="detail"><code>${escapeHtml(compactJson(tool.result))}</code></span></div>`,
    ),
    terminal === null
      ? `<div class="trace-line"><span class="ts">-</span><span class="turn-num">status</span><span class="label">${escapeHtml(statusLabel(status))}</span><span class="detail">${escapeHtml(compactJson(status))}</span></div>`
      : `<div class="trace-line terminal-${escapeAttr(terminal.kind)}"><span class="ts">${escapeHtml(fmtTime(terminal.at))}</span><span class="turn-num">terminal</span><span class="label">${escapeHtml(terminal.event)}</span><span class="detail">${escapeHtml(compactJson(terminal.payload))}</span></div>`,
  ].join("");
  return `<div class="run-summary"><span class="badge ${escapeAttr(statusClass(status))}">${escapeHtml(statusLabel(status))}</span>${kv("startedAt", fmtTime(trace.startedAt))}${kv("turns", trace.turns.length)}${kv("toolCalls", trace.toolCalls.length)}</div>
    <div class="trace-container"><div class="trace-list">${lines}</div></div>`;
};

export const renderEventsWorkspace = (
  opts: NormalizedOpsHtmxOptions,
  scope: string,
  runId: number | undefined,
  result: ApiResult<ReadonlyArray<LedgerEventRpc>>,
  query: { readonly afterId?: number; readonly limit: number; readonly kinds?: string },
): string => `<div class="scope-header">
    <h2>${escapeHtml(scope)}</h2>
    <div class="scope-meta"><span class="surface-badge">events</span></div>
  </div>
  ${renderTabs(opts, scope, runId, "events")}
  <section class="section">
    <header><h3>event stream</h3><span class="endpoint-tag">GET /scopes/:scope/events</span></header>
    <div class="section-body">
      ${!result.ok ? errorBlock(result) : renderEventsTable(opts, scope, runId, result.value, query)}
    </div>
  </section>`;

const renderEventsTable = (
  opts: NormalizedOpsHtmxOptions,
  scope: string,
  runId: number | undefined,
  rows: ReadonlyArray<LedgerEventRpc>,
  query: { readonly afterId?: number; readonly limit: number; readonly kinds?: string },
): string => {
  const body = rows
    .map(
      (event) => `<tr>
        <td class="id">${escapeHtml(event.id)}</td>
        <td class="ts">${escapeHtml(fmtTime(event.ts))}</td>
        <td class="kind">${escapeHtml(event.kind)}</td>
        <td class="payload"><details><summary>payload</summary><pre>${escapeHtml(prettyJson(event.payload))}</pre></details></td>
      </tr>`,
    )
    .join("");
  const last = rows.at(-1)?.id;
  const next =
    last === undefined || rows.length < query.limit
      ? ""
      : `<a class="pager" hx-get="${escapeAttr(uiPath(opts, "fragments/events", { scope, runId, afterId: last, limit: query.limit, kinds: query.kinds }))}" hx-target="#workspace-panel" hx-swap="innerHTML">after #${escapeHtml(last)}</a>`;
  return `<form class="events-header" hx-get="${escapeAttr(uiPath(opts, "fragments/events"))}" hx-target="#workspace-panel" hx-swap="innerHTML">
      <input type="hidden" name="scope" value="${escapeAttr(scope)}">
      ${runId === undefined ? "" : `<input type="hidden" name="runId" value="${escapeAttr(runId)}">`}
      <span class="cursor">afterId <b>${escapeHtml(query.afterId ?? 0)}</b></span>
      <input class="filter-input compact" name="kinds" placeholder="kinds" value="${escapeAttr(query.kinds ?? "")}">
      <input class="filter-input mini" name="limit" value="${escapeAttr(query.limit)}">
    </form>
    <table class="events"><thead><tr><th>id</th><th>ts</th><th>kind</th><th>payload</th></tr></thead><tbody>${body}</tbody></table>
    ${rows.length === 0 ? emptyBlock("events") : next}`;
};

export const renderTelemetryWorkspace = (
  opts: NormalizedOpsHtmxOptions,
  scope: string,
  runId: number | undefined,
  results: {
    readonly quota?: ApiResult<QuotaState>;
    readonly resource?: ApiResult<ResourceState>;
    readonly admission?: ApiResult<CapabilityLease | null>;
  },
  values: {
    readonly quotaKey?: string;
    readonly windowMs?: string;
    readonly quotaLimit?: string;
    readonly resourceKey?: string;
    readonly admissionKey?: string;
  },
): string => `<div class="scope-header">
    <h2>${escapeHtml(scope)}</h2>
    <div class="scope-meta"><span class="surface-badge">telemetry</span></div>
  </div>
  ${renderTabs(opts, scope, runId, "telemetry")}
  <div class="telemetry-grid">
    ${projectionSection(opts, scope, runId, "quota", "GET /scopes/:scope/quota", [
      ["quotaKey", "key", values.quotaKey ?? ""],
      ["windowMs", "windowMs", values.windowMs ?? "Infinity"],
      ["quotaLimit", "limit", values.quotaLimit ?? "1"],
    ], results.quota)}
    ${projectionSection(opts, scope, runId, "resource", "GET /scopes/:scope/resource", [
      ["resourceKey", "key", values.resourceKey ?? ""],
    ], results.resource)}
    ${projectionSection(opts, scope, runId, "admission", "GET /scopes/:scope/admission", [
      ["admissionKey", "key", values.admissionKey ?? ""],
    ], results.admission)}
  </div>`;

const projectionSection = (
  opts: NormalizedOpsHtmxOptions,
  scope: string,
  runId: number | undefined,
  title: string,
  endpoint: string,
  fields: ReadonlyArray<readonly [string, string, string]>,
  result: ApiResult<unknown> | undefined,
): string => `<section class="section">
  <header><h3>${escapeHtml(title)}</h3><span class="endpoint-tag">${escapeHtml(endpoint)}</span></header>
  <div class="section-body">
    <form class="projection-form" hx-get="${escapeAttr(uiPath(opts, "fragments/telemetry"))}" hx-target="#workspace-panel" hx-swap="innerHTML">
      <input type="hidden" name="scope" value="${escapeAttr(scope)}">
      ${runId === undefined ? "" : `<input type="hidden" name="runId" value="${escapeAttr(runId)}">`}
      ${fields.map(([name, label, value]) => `<label><span>${escapeHtml(label)}</span><input name="${escapeAttr(name)}" value="${escapeAttr(value)}"></label>`).join("")}
    </form>
    ${result === undefined ? "" : result.ok ? jsonBlock(result.value) : errorBlock(result)}
  </div>
</section>`;

const renderTabs = (
  opts: NormalizedOpsHtmxOptions,
  scope: string,
  runId: number | undefined,
  active: WorkspaceTab,
): string => `<nav class="view-tabs">
  ${runId === undefined ? "" : tab(opts, scope, runId, "trace", active, "Trace", uiPath(opts, "fragments/select-run", { scope, runId }), "#oob-target")}
  ${tab(opts, scope, runId, "events", active, "Events", uiPath(opts, "fragments/events", { scope, runId, limit: opts.eventLimit }), "#workspace-panel")}
  ${tab(opts, scope, runId, "telemetry", active, "Telemetry", uiPath(opts, "fragments/telemetry", { scope, runId }), "#workspace-panel")}
</nav>`;

const tab = (
  opts: NormalizedOpsHtmxOptions,
  scope: string,
  runId: number | undefined,
  key: WorkspaceTab,
  active: WorkspaceTab,
  label: string,
  fragmentPath: string,
  target: string,
): string => {
  const shellPath = canonicalShellPath(opts, scope, runId, key);
  return `<a class="view-tab-btn${active === key ? " active" : ""}" href="${escapeAttr(shellPath)}" hx-get="${escapeAttr(fragmentPath)}" hx-target="${escapeAttr(target)}" hx-swap="innerHTML" hx-push-url="${escapeAttr(shellPath)}">${escapeHtml(label)}</a>`;
};

const canonicalShellPath = (
  opts: NormalizedOpsHtmxOptions,
  scope: string,
  runId: number | undefined,
  tabName: WorkspaceTab,
): string =>
  uiPath(opts, "", {
    scope,
    runId,
    tab: tabName,
  });

export const renderSelectScopeOob = (parts: {
  readonly scopes: string;
  readonly runs: string;
  readonly workspace: string;
}): string => `<div id="scopes-panel" hx-swap-oob="innerHTML">${parts.scopes}</div>
<div id="runs-panel" hx-swap-oob="innerHTML">${parts.runs}</div>
<div id="workspace-panel" hx-swap-oob="innerHTML">${parts.workspace}</div>`;

export const renderSelectRunOob = (parts: {
  readonly runs: string;
  readonly workspace: string;
}): string => `<div id="runs-panel" hx-swap-oob="innerHTML">${parts.runs}</div>
<div id="workspace-panel" hx-swap-oob="innerHTML">${parts.workspace}</div>`;

export const chooseInitialScope = (
  scopes: ReadonlyArray<ScopeSummary>,
  requested: string | null,
): ScopeSummary | undefined =>
  scopes.find((s) => s.scope === requested) ??
  scopes.find((s) => s.surface === "agent-do/v0.3") ??
  scopes[0];

export const chooseInitialRun = (
  page: RunListPage | undefined,
  requested: string | null,
): RunSummary | undefined => {
  const parsed = requested === null ? undefined : Number(requested);
  if (parsed !== undefined && Number.isInteger(parsed)) {
    const matched = page?.runs.find((run) => run.runId === parsed);
    if (matched !== undefined) return matched;
  }
  return page?.runs[0];
};

export const scopeRunsTail = (
  scope: string,
  query = "runs",
): string => encodedScopeTail(scope, query);

const kv = (key: string, value: unknown): string =>
  `<div class="kv"><span class="k">${escapeHtml(key)}</span><span class="v">${escapeHtml(value)}</span></div>`;

const jsonBlock = (value: unknown): string =>
  `<pre class="json">${escapeHtml(prettyJson(value))}</pre>`;

const CSS = `
:root {
  --bg-0:#fff; --bg-1:#f8fafc; --bg-2:#f1f5f9; --bg-hover:#e2e8f0;
  --border:#cbd5e1; --border-muted:#e2e8f0;
  --fg-0:#0f172a; --fg-1:#334155; --fg-2:#64748b; --fg-3:#94a3b8;
  --accent:#2563eb; --green:#16a34a; --red:#dc2626; --amber:#d97706;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
}
*{box-sizing:border-box} body{margin:0;background:var(--bg-0);color:var(--fg-1);font-family:var(--sans);font-size:12px;line-height:1.5;height:100vh;overflow:hidden} code,.mono{font-family:var(--mono)}
.topbar{display:flex;align-items:center;justify-content:space-between;height:44px;padding:0 20px;border-bottom:1px solid var(--border);background:var(--bg-0);flex-shrink:0}
.brand{font-weight:700;color:var(--fg-0);font-size:13px}.brand span{color:var(--fg-2);font-weight:400;margin-left:8px;font-family:var(--mono);font-size:11px}.meta{color:var(--fg-2);font-family:var(--mono);font-size:11px}
.layout{display:grid;grid-template-columns:220px 250px 1fr;height:calc(100vh - 44px);overflow:hidden}.column{display:flex;flex-direction:column;height:100%;overflow:hidden;border-right:1px solid var(--border)}
.scopes-column,.runs-column{background:var(--bg-1)}.endpoint,.header-desc{padding:12px 16px;font-family:var(--mono);font-size:10px;color:var(--fg-2);background:var(--bg-2);border-bottom:1px solid var(--border);font-weight:600}
h3{margin:16px 16px 8px;font-size:10px;text-transform:uppercase;color:var(--fg-2);font-weight:700;letter-spacing:.05em}.scopes-list,.runs-list{flex:1;overflow-y:auto}
.scope-row,.run-list-item{display:flex;text-decoration:none;color:inherit;border-bottom:1px solid var(--border-muted);border-left:3px solid transparent;cursor:pointer}
.scope-row{align-items:center;justify-content:space-between;padding:8px 16px;font-family:var(--mono);font-size:11px}.scope-row:hover,.run-list-item:hover{background:var(--bg-hover)}.scope-row.active,.run-list-item.active{background:var(--bg-0);color:var(--accent);font-weight:600;border-left-color:var(--accent)}
.surface{font-size:9px;color:var(--fg-2);background:var(--bg-2);padding:1px 4px;border:1px solid var(--border-muted)}.opaque .surface{color:var(--fg-3);background:transparent}
.filter-container{padding:12px 16px 16px;border-top:1px solid var(--border);background:var(--bg-1)}.filter-container h3{margin:0 0 8px;padding:0}.filter-input,select.filter-input{width:100%;padding:6px 10px;background:var(--bg-0);border:1px solid var(--border);color:var(--fg-0);font-family:var(--mono);font-size:11px;outline:none}.filter-input:focus{border-color:var(--accent)}.compact{width:180px}.mini{width:58px}
.run-list-item{flex-direction:column;gap:4px;padding:10px 16px;background:var(--bg-0)}.run-top{display:flex;justify-content:space-between;align-items:center}.runId{font-family:var(--mono);font-size:11px;font-weight:700}.run-time{font-size:9px;color:var(--fg-2);font-family:var(--mono)}
.workspace{overflow-y:auto;border-right:none;padding:20px 24px;background:var(--bg-0)}.scope-header{display:flex;align-items:center;justify-content:space-between;padding-bottom:12px;border-bottom:1px solid var(--border);margin-bottom:16px}.scope-header h2{margin:0;font-family:var(--mono);font-size:15px;color:var(--fg-0);font-weight:700}.scope-meta{font-size:11px;color:var(--fg-2);display:flex;gap:12px;align-items:center}.surface-badge{background:var(--bg-2);border:1px solid var(--border);padding:2px 6px;font-family:var(--mono);font-size:10px;color:var(--fg-1);font-weight:500}
.view-tabs{display:flex;gap:8px;border-bottom:1px solid var(--border);margin-bottom:16px}.view-tab-btn{padding:8px 16px;text-decoration:none;border:1px solid transparent;border-bottom:none;font-size:12px;font-weight:600;color:var(--fg-2);margin-bottom:-1px}.view-tab-btn:hover{color:var(--fg-0)}.view-tab-btn.active{color:var(--accent);background:var(--bg-0);border-color:var(--border) var(--border) var(--bg-0)}
.section{background:var(--bg-0);border:1px solid var(--border);margin-bottom:16px;display:flex;flex-direction:column}.section header{display:flex;align-items:center;justify-content:space-between;padding:6px 12px;border-bottom:1px solid var(--border);background:var(--bg-1)}.section header h3{margin:0;font-size:11px;color:var(--fg-0)}.endpoint-tag{font-family:var(--mono);font-size:9px;color:var(--fg-2);background:var(--bg-2);padding:1px 6px;border:1px solid var(--border-muted)}.section-body{padding:16px}
.badge{display:inline-block;padding:2px 6px;font-family:var(--mono);font-size:10px;font-weight:600;line-height:1.2}.badge.delivered{color:#166534;background:#f0fdf4}.badge.aborted{color:#991b1b;background:#fef2f2}.badge.open{color:#9a3412;background:#fff7ed}.badge.orphaned{color:#374151;background:#f3f4f6}
.state{margin:16px;padding:16px;border:1px solid var(--border);background:var(--bg-1);display:flex;gap:8px;align-items:baseline;font-family:var(--mono)}.state-error{border-color:#fca5a5;background:#fef2f2;color:#991b1b}.state small{color:var(--fg-2)}
.events-header{display:flex;gap:12px;align-items:center;margin-bottom:12px;flex-wrap:wrap;font-size:11px}.cursor{font-family:var(--mono);color:var(--fg-2)}.cursor b{color:var(--fg-0)}
table.events{width:100%;border-collapse:collapse;font-family:var(--mono);font-size:11px}table.events th,table.events td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--border-muted);vertical-align:top}table.events th{background:var(--bg-1);color:var(--fg-2);font-weight:700;font-size:10px;text-transform:uppercase;border-bottom:1px solid var(--border)}td.id{color:var(--fg-3);width:50px}td.ts{color:var(--fg-2);width:160px}td.kind{color:var(--fg-0);font-weight:600;width:210px}td.payload details{min-width:180px}td.payload summary{cursor:pointer;color:var(--accent);font-weight:600;list-style:none}td.payload summary::-webkit-details-marker{display:none}td.payload summary:before{content:"+";display:inline-block;width:14px;color:var(--fg-2)}td.payload details[open] summary{margin-bottom:8px}td.payload details[open] summary:before{content:"-"}td.payload pre,.json{margin:0;font-family:var(--mono);font-size:11px;color:var(--fg-0);white-space:pre-wrap;overflow-x:auto;background:var(--bg-1);border:1px solid var(--border-muted);padding:8px}
.trace-container{border:1px solid var(--border);background:var(--bg-0);padding:16px 20px}.trace-list{position:relative;padding-left:20px;display:flex;flex-direction:column;gap:14px}.trace-list:before{content:"";position:absolute;left:4px;top:6px;bottom:6px;width:1px;background:var(--border)}.trace-line{position:relative;display:grid;grid-template-columns:155px 60px 160px 1fr;gap:12px;font-family:var(--mono);font-size:11px;align-items:baseline}.trace-line:before{content:"";position:absolute;left:-19px;top:5px;width:7px;height:7px;background:var(--fg-3);border:1.5px solid var(--bg-0)}.trace-line.terminal-delivered:before{background:var(--green);width:9px;height:9px;left:-20px;top:4px}.trace-line.terminal-aborted:before{background:var(--red);width:9px;height:9px;left:-20px;top:4px}.ts{color:var(--fg-2)}.turn-num{color:var(--fg-2);font-size:9px;font-weight:700;text-transform:uppercase}.label{color:var(--fg-0);font-weight:600}.detail{color:var(--fg-1)}
.kv{display:grid;grid-template-columns:120px 1fr;gap:4px 12px;font-family:var(--mono);font-size:11px;padding:4px 0}.k{color:var(--fg-2)}.v{color:var(--fg-0)}.run-summary{display:flex;gap:12px;align-items:center;margin-bottom:16px;flex-wrap:wrap}
.telemetry-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:20px}.projection-form{display:grid;gap:8px;margin-bottom:12px}.projection-form label{display:grid;grid-template-columns:75px 1fr;gap:8px;align-items:center;font-family:var(--mono);font-size:11px}.projection-form input{padding:6px 8px;border:1px solid var(--border);font-family:var(--mono);font-size:11px}.pager{display:block;margin:12px 16px;font-family:var(--mono);font-size:11px;color:var(--accent)}
@media (max-width:900px){body{overflow:auto;height:auto}.layout{grid-template-columns:1fr;height:auto}.column{min-height:260px;border-right:none;border-bottom:1px solid var(--border)}.telemetry-grid{grid-template-columns:1fr}.trace-line{grid-template-columns:1fr}.topbar{align-items:flex-start;flex-direction:column;height:auto;padding:10px 16px;gap:4px}}
`;
