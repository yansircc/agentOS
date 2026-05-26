# Spec 36: ops-htmx Boundary

> **Status**: Draft v0.1
> **Date**: 2026-05-27
> **Depends on**: spec-35 (`@agent-os/ops-api`)
> **Pressure evidence**: `docs/notes/spec-35-ops-ui-mockup.html`

---

## 0. Purpose

`@agent-os/ops-htmx` is a read-only SSR + HTMX console over the spec-35
ops-api. It is not a second ops-api, not a scope registry, and not an operator
control plane.

The package owns only:

1. HTML shell rendering.
2. HTML fragment rendering.
3. GET request construction against `@agent-os/ops-api`.

It owns no storage and no projection logic.

---

## 1. Invariant

> ops-htmx renders presentation from ops-api responses. Every fact shown in the
> UI is fetched from `GET /__ops/api/*` for the current request. The package
> must not call `AgentDOBase`, hold shadow state, or introduce app nouns.

Corollaries:

- **C-1.** `apiFetch` is required. There is no hidden resolver, namespace, or
  fallback data source.
- **C-2.** All mounted routes are `GET`; non-GET returns 405.
- **C-3.** UI routes may compose multiple ops-api GETs for one page, but each
  value displayed remains owned by its upstream ops-api response.
- **C-4.** App-specific operations such as approval, retry, publish, deploy,
  and workflow event submission are out of scope.
- **C-5.** All dynamic text, attributes, and JSON payloads are HTML-escaped
  before rendering.

---

## 2. Mount Contract

```ts
interface MountOpsHtmxOptions {
  readonly apiFetch: (request: Request) => Promise<Response>
  readonly uiBase?: string      // default "/__ops"
  readonly apiBase?: string     // default "/__ops/api"
  readonly title?: string       // default "@agent-os/ops"
  readonly htmxScriptSrc?: string | null
}
```

The usual Worker composition is:

```ts
const api = mountOpsApi(...)
const ui = mountOpsHtmx({ apiFetch: api })
```

The UI forwards the incoming request headers to ops-api GET requests so that
`OpsAuth` remains the single auth decision point.

---

## 3. Route Surface

All routes are under `uiBase`.

```text
GET /__ops
GET /__ops/fragments/scopes
GET /__ops/fragments/select-scope?scope=...
GET /__ops/fragments/select-run?scope=...&runId=...
GET /__ops/fragments/events?scope=...&afterId=&limit=&kinds=
GET /__ops/fragments/telemetry?scope=...&quotaKey=&windowMs=&quotaLimit=&resourceKey=&admissionKey=
```

`select-scope` and `select-run` return HTMX out-of-band fragments for the
affected columns. They do not mutate server state.

---

## 4. Acceptance

1. Package code contains no app nouns (`change`, `lead`, `site`, `schema`,
   `conversation`) in source routes or render labels.
2. Every data-bearing fragment calls only `apiFetch` with `GET /__ops/api/*`.
3. Missing `apiFetch` fails at mount construction.
4. Non-GET UI requests return 405.
5. ops-api `501 not_introspectable` renders an explicit unsupported scope state.
6. Event cursor, kind filter, and limit pass through to ops-api.
7. Dynamic scope, event, run, and JSON payload text is escaped.
8. There are no mutation controls or app-saga actions.
