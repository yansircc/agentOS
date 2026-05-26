# Spec 35: ops-api Boundary and Contract

> **Status**: Draft v0.1
> **Date**: 2026-05-27
> **Triggers**: ship `@agent-os/ops-api` v0.1.0 as the infrastructure projection HTTP layer.
> **Depends on**: spec-24 §1/§5.4 (invariant + ops-api endpoint family), spec-25 §7 (AttemptKey), spec-29 (event stream wire), spec-34 §5 (standard projections — adds `runs(spec)`), spec-34 §8.1 (`AgentDOBase` RPC surface).
> **Pressure evidence**: dialogue + mockup `docs/notes/spec-35-ops-ui-mockup.html` derived from substrate-only ops console requirements (no app nouns, no business UI, no operator actions).

---

## 0. Purpose

ops-api turns `AgentDOBase`'s already-public RPC surface into HTTP. It is **not** a new substrate. It is **not** a business UI. It is **not** a control plane (no writes, no operator actions, no scheduling).

Three failures it must avoid by construction:

1. **Inventing a global scope registry.** agent-OS core has no scope index; scope identity is owned by the deploying app's DO topology (spec-24 §8). ops-api therefore takes a `ScopeResolver` from the app.
2. **Becoming an LLM/agent control plane.** No `POST` endpoints in v0. Operator decisions, approvals, retries, cancels — all are app sagas (`gated-effect-chain.md`).
3. **Becoming a business dashboard.** No app nouns (`change / lead / site / schema / conversation`). Every column maps to substrate vocabulary (scope / run / event / cap owner / quota / resource / admission lease).

v0 ships **one HTTP boundary** + **three injected hooks** (`ScopeResolver`, `OpsAuth`, `Worker fetch`). Nothing else.

---

## 1. Invariant

> **ops-api is a stateless HTTP projection of `AgentDOBase` RPC. Every response is `project(events)` or its derived form, fetched on demand from the scope's DO. ops-api owns no storage, no aggregation cache, no second writer.**

Corollaries:

- **C-1.** Every endpoint corresponds to **exactly one** `AgentDOBase` RPC call (or `ScopeResolver` call) plus serialization. No endpoint composes multiple RPCs server-side; cross-scope joining is a client concern.
- **C-2.** `ScopeResolver` is the only path from `scope: string` to `DurableObjectNamespace`. ops-api never reads scopes from `wrangler.toml`, env, or a hidden registry.
- **C-3.** `OpsAuth` runs **before** any scope resolution or RPC dispatch. Auth failure = 401 (missing principal) or 403 (denied scope). Never 200-with-empty-body.
- **C-4.** Opaque scopes (`surface !== "agent-do/v0.3"`) appear in `/scopes` but return `501 not_introspectable` for `/runs`, `/events`, `/quota`, `/resource`, `/admission`.

---

## 2. Endpoint surface (v0)

Nine endpoints. All `GET`. No `POST`/`PUT`/`DELETE` in v0.

```
GET /__ops/api/scopes
GET /__ops/api/scopes/:scope/events
GET /__ops/api/scopes/:scope/stream
GET /__ops/api/scopes/:scope/runs
GET /__ops/api/scopes/:scope/runs/:runId/trace
GET /__ops/api/scopes/:scope/runs/:runId/status
GET /__ops/api/scopes/:scope/quota
GET /__ops/api/scopes/:scope/resource
GET /__ops/api/scopes/:scope/admission
```

`:scope` is **URL-encoded** because scope keys may contain `/` per spec-24 §8 convention (`thread/xxx`, `wp/zy@acme.com`). The Worker route mounts at `/__ops/api/scopes/:scope/*` and decodes `:scope` once.

### 2.1 `GET /__ops/api/scopes`

Lists all scopes the principal can introspect.

Query: `?prefix=...&limit=N`. Default limit 100, max 1000.

Response:
```ts
{
  scopes: ReadonlyArray<ScopeSummary>
}
```

**v0 has no pagination cursor.** The resolver returns the full
candidate set (up to `limit`); ops-api filters by `authorize(read)`
per scope. Resolver-level cursor pagination is incompatible with
authorize-after-fetch — authorized scopes can hide behind an
unauthorized prefix on a later page. Apps with very large scope
counts should pre-filter by principal inside their resolver. See
§9 open question.

### 2.2 `GET /__ops/api/scopes/:scope/events`

Cursor-paginated event snapshot (spec-34 §5 `events()`).

Query: `?afterId=N&limit=M&kinds=k1,k2`. Default limit 1000.

Response: `ReadonlyArray<LedgerEventRpc>` (spec-24 §5.4 shape).

`404` if scope unknown. `501 not_introspectable` if scope opaque.

### 2.3 `GET /__ops/api/scopes/:scope/stream`

Live tail SSE (spec-29 `streamEvents`).

Query: `?kinds=k1,k2&heartbeatMs=N`. `afterId` is read from HTTP `Last-Event-ID` header (spec-29 §2.3). The Worker fetch handler parses the header and passes it to `streamEvents({ afterId })`.

Response: `Response` with `Content-Type: text/event-stream`. Body wire is spec-29 (event `ledger`, id = ledger id, data = `LedgerEventRpc`).

Reconnect: client sends `Last-Event-ID: N` → server resumes at `afterId = N`. No gap, no duplicate (spec-29 C-2).

`404` / `501` same as §2.2.

### 2.4 `GET /__ops/api/scopes/:scope/runs`

List runs for the scope. **1:1 RPC** mapping to
[spec-34 §5 `runs(spec)`](./spec-34-authorized-commit-calculus.md#5-standard-projections).

Query: `?status=delivered|aborted|open_without_terminal|orphaned&afterRunId=N&limit=M`.
Default limit 50, max 500. `status` accepts multiple values via comma
(`?status=aborted,open_without_terminal`).

Response: `RunListPage` (spec-34 §5).

`RunSummary` is lightweight — turn/tool detail belongs to `/runs/:runId/trace`.

`404` / `501` same as §2.2.

**Implementation discipline**: ops-api MUST call `stub.runs(spec)` and
return the result directly. ops-api MUST NOT synthesize this list
from `events()` filtered by run-bearing kinds: event-level cursor
pagination over an unbounded scope truncates the newest runs (the
ASC cursor starts from the oldest end). The projection lives on the
DO side where the full scope ledger is accessible without artificial
batch caps. See spec-34 §5.

### 2.5 `GET /__ops/api/scopes/:scope/runs/:runId/trace`

Single run trace (spec-34 §5 `runTrace`).

`:runId` is a numeric ledger event id (the `agent.run.started` row's id).

Response: `RunTrace` (spec-34 §5).

`404` if scope unknown OR runId is not a known `agent.run.started` event in this scope.

### 2.6 `GET /__ops/api/scopes/:scope/runs/:runId/status`

Single run status (spec-34 §5 `runStatus`).

Response: `RunStatus` (the 4-value union: `delivered | aborted | open_without_terminal | orphaned`).

`404` rule same as §2.5.

### 2.7 `GET /__ops/api/scopes/:scope/quota`

Quota projection (spec-34 §5 `quotaState`).

Query: `?key=...&windowMs=N&limit=M`. All three required.

- `windowMs`: positive integer milliseconds, OR literal string `Infinity`
  (unbounded window). Zero / negative finite values are rejected.
- `limit`: integer ≥ 1.

Response: `QuotaState` (spec-34 §5).

`400` if any required query param is missing, if `windowMs` is finite and
not a positive integer, if `windowMs` is `Infinity` mixed with another non-
integer literal, or if `limit < 1`. Negative `windowMs` would compute
`now - windowMs > now`, producing a future cutoff and a misleading
zero-consumption projection — ops-api rejects fast.

### 2.8 `GET /__ops/api/scopes/:scope/resource`

Resource projection (spec-34 §5 `resourceState`).

Query: `?key=...`. Required.

Response: `ResourceState`.

`400` if `key` missing.

### 2.9 `GET /__ops/api/scopes/:scope/admission`

Admission lease projection (spec-34 §5 `admissionLease`).

Query: `?key=<base64url JSON AttemptKey>`. Required.

`AttemptKey` is a 4-tuple `{ routeFingerprint, schemaFingerprint, strategy, adapterVersion }` (spec-25 §7). It carries no hierarchy, so URL path embedding is forbidden by §2.9 of this spec. The encoding rule:

1. JSON-stringify the AttemptKey object.
2. Encode as base64url (RFC 4648 §5, no padding).
3. Pass as single `?key=` query param.

ops-api decodes, validates the four fields are present, all are non-empty
strings, and calls `agentDO.admissionLease(decoded)`. **`strategy` is
opaque to ops-api**: the implementation accepts any non-empty string and
lets the DO's `admissionLease()` reject unknown strategies upstream.
This avoids ops-api drift when core's `Strategy` union grows (spec-25
expects it to). Apps that need strict client-side enum validation
should validate before constructing the URL.

Response: `CapabilityLease | null`.

`400` if `key` missing, malformed base64url, malformed JSON, or fails AttemptKey shape validation (non-string or empty field).

---

## 3. Type contracts

### 3.1 `ScopeResolver`

App-provided. ops-api has no fallback.

```ts
interface ScopeResolver {
  list(filter: {
    prefix?: string;
    limit?: number;
  }): Promise<ReadonlyArray<ScopeSummary>>
  resolve(scope: string): Promise<ResolvedScope | null>
}

interface ScopeSummary {
  readonly scope: string
  readonly surface: ScopeSurface
}

interface ResolvedScope {
  readonly scope: string
  readonly surface: ScopeSurface
  readonly namespace?: DurableObjectNamespace   // only present for introspectable scopes
}

type ScopeSurface = "agent-do/v0.3" | "opaque"
```

Discipline:

- **D-1.** `ScopeSummary` is the **only** serializable shape ops-api exposes for `/scopes`. `namespace` is intentionally absent — runtime targets do not cross the HTTP boundary.
- **D-2.** `resolve` returning `null` = scope unknown = `404`. The resolver must not throw for unknown scopes.
- **D-3.** `ResolvedScope.namespace` is the DO binding used to obtain a stub. ops-api fetches via `namespace.get(namespace.idFromName(scope)).fetch(...)` or DO RPC client — the actual transport is an implementation detail.
- **D-4.** `surface: "opaque"` paths return `501 not_introspectable` from every introspection endpoint; only `/scopes` lists them.

### 3.2 `OpsAuth`

```ts
interface OpsAuth {
  authenticate(req: Request): Promise<OpsPrincipal | null>
  authorize(
    principal: OpsPrincipal,
    scope: string,
    action: "read" | "stream",
  ): Promise<boolean>
}

interface OpsPrincipal {
  readonly subject: string
  readonly tenantId?: string
  readonly claims: Readonly<Record<string, unknown>>
}
```

Discipline:

- **D-5.** `authenticate(req)` returns `null` ⇒ `401`. ops-api never falls back to a default principal.
- **D-6.** `authorize(principal, scope, action)` returns `false` ⇒ `403`. Authorization runs **after** scope resolution (the scope must exist before deciding access).
- **D-7.** `action` is one of `"read"` (snapshot endpoints) or `"stream"` (the live tail). Apps may grant `read` without `stream`. Other actions are not in v0.

### 3.3 `mountOpsApi`

```ts
interface MountOpsApiOptions {
  readonly scopeResolver: ScopeResolver
  readonly auth: OpsAuth
}

function mountOpsApi(opts: MountOpsApiOptions): (request: Request) => Promise<Response>
```

The returned handler is the Worker fetch entry. Apps call it from their Worker:

```ts
export default {
  async fetch(req, env) {
    const handler = mountOpsApi({
      scopeResolver: new AppScopeResolver(env),
      auth: new AppOpsAuth(env),
    })
    return handler(req)
  }
}
```

ops-api **never** instantiates `ScopeResolver` or `OpsAuth` itself; the app owns construction (including reading env bindings).

### 3.4 `RunSummary`

```ts
type RunStatus =
  | { kind: "delivered";              at: number; event: string }
  | { kind: "aborted";                at: number; abortKind: string }
  | { kind: "open_without_terminal";  startedAt: number }
  | { kind: "orphaned";               startedAt: number; evidence: string }

interface RunSummary {
  readonly runId: number
  readonly startedAt: number
  readonly status: RunStatus
  readonly durationMs?: number    // only when status.kind in {delivered, aborted}
}
```

`RunSummary` deliberately omits turns/toolCalls/tokensUsed. Those require `/runs/:runId/trace`.

---

## 4. Error responses

Uniform shape:

```ts
interface OpsErrorBody {
  readonly error: string         // machine code, e.g. "scope_not_found"
  readonly message: string       // human description
}
```

Status codes:

| Status | Code                       | When                                           |
|--------|----------------------------|------------------------------------------------|
| 400    | `bad_request`              | Missing required query, malformed AttemptKey   |
| 401    | `unauthenticated`          | `authenticate` returned null                   |
| 403    | `forbidden`                | `authorize` returned false                     |
| 404    | `scope_not_found`          | `resolve` returned null                        |
| 404    | `run_not_found`            | runId has no `agent.run.started` in scope      |
| 501    | `not_introspectable`       | scope is opaque                                |
| 502    | `upstream_failure`         | DO fetch threw / SqlError surfaced             |

No silent fallback. No "200 with empty body" for any unknown state.

---

## 5. Authorization flow

```
request → authenticate(req)
  → null → 401
  → principal → parse :scope
              → scopeResolver.resolve(scope)
                  → null → 404 scope_not_found
                  → resolved → authorize(principal, scope, action)
                            → false → 403 forbidden
                            → true  → surface check
                                    → "opaque" → 501 not_introspectable
                                    → "agent-do/v0.3" → dispatch RPC → serialize
```

`action` mapping:

- `/scopes`                                         → `read` (against authorize over the special scope `""`, or skipped — see §5.1)
- `/scopes/:scope/events` `/runs` `/runs/:runId/*` `/quota` `/resource` `/admission` → `read`
- `/scopes/:scope/stream`                           → `stream`

### 5.1 Listing authorization

`/scopes` returns scopes the principal can access. ops-api filters `scopeResolver.list()` results: each scope is included only if `authorize(principal, scope, "read")` returns true.

Implementation MAY batch authorize calls if the OpsAuth supports it, but the contract is per-scope. v0 implementation may do this naively (N authorize calls); apps optimize their OpsAuth if N is large.

---

## 6. Verification (acceptance for v0 ship)

The implementation PR must demonstrate:

1. **No app noun anywhere in the package surface.** Greps for `change|lead|site|schema|conversation|workflow|customer|order|product` in `packages/ops-api/src/**` return zero hits (besides incidental matches in import paths from `@agent-os/core`, none of which are app nouns).
2. **All 9 endpoints map 1:1 to AgentDOBase RPC or ScopeResolver.** No server-side cross-scope join. No multi-RPC composition.
3. **`OpsAuth` is mandatory.** `mountOpsApi({})` (missing fields) fails fast at construction. Auth missing on a request → 401, never 200.
4. **Scope unknown → 404, opaque scope → 501 not_introspectable.** Both checked per endpoint; no silent fallback to empty body.
5. **`/events` pagination is gap-free and duplicate-free over ≥3 cursor steps.** Test feeds N rows, paginates with limit=K, asserts union of pages equals N rows with strictly ascending ids.
6. **`/stream` reconnect with `Last-Event-ID` is gap-free and duplicate-free.** Test starts a stream, drops connection mid-flight, reconnects with `Last-Event-ID: <last-received>`, asserts continuation.
7. **AttemptKey query encoding round-trips.** Test base64url(JSON({routeFingerprint, schemaFingerprint, strategy, adapterVersion})) and asserts the decoded object equals the input.
8. **`/scopes` filters by principal.** Test with two principals (`a`, `b`); resolver has 3 scopes; authorize permits `a` to see scope 1+2, `b` to see scope 3. Assert each principal's `/scopes` response contains only its allowed set.
9. **No `POST`/`PUT`/`DELETE` handler exists in the package.** Method-not-allowed for any non-GET request → 405.

Tests use an in-memory `MockScopeResolver` + `MockOpsAuth` + an in-memory `AgentDOBase`-shaped stub. No real DO required.

---

## 7. What is intentionally NOT in v0

These are not deferred-to-soon items. They are **excluded by design** until pressure evidence appears.

| Feature                            | Reason                                                                                         |
|------------------------------------|------------------------------------------------------------------------------------------------|
| `POST /workflows/:id/event`        | Operator actions are app sagas (`gated-effect-chain.md`), not ops-api. Removing this from spec-24 §5.4 is intentional. |
| `GET /__ops/api/cost`              | No cost projection exists in core. Quota is not cost. Wait for explicit `cost.*` vocabulary or AI Gateway cost evidence. |
| Cross-scope fan-in                 | spec-30 watchlist; client opens N parallel `/stream` connections; substrate primitive only when O(10) connection pressure surfaces. |
| Approval / publish endpoints       | Operator decisions are `cap_app` facts (`approval.decided`, `change.approval.decided`). ops-api MUST NOT mint these. |
| Mutation endpoints (any)           | v0 is read-only. Writes go through `AgentDOBase.emitEvent` / scope-owning app surface, not ops-api. |
| Pre-computed dashboards / charts   | Every value is `project(events)` on demand. No backing aggregation tables. |
| React UI (`@agent-os/ops-react`)   | Separate package, not v0. UI shape is opinion-laden; lock the API contract first. |
| Cross-tenant ScopeResolver default | App-provided. ops-api ships no default resolver. |

---

## 8. Spec amendments

| Spec    | Section          | Action                                                                                          |
|---------|------------------|-------------------------------------------------------------------------------------------------|
| spec-24 | §5.4 Admin Query HTTP API | **Supersede**: replaced by spec-35 §2. The old endpoint set (`/runs?scope=`, `/workflows/...`, `/cost`) is no longer the contract. |
| spec-24 | §5.4 `POST /workflows/:id/event` | **Delete**: operator actions are app sagas, not ops-api. App may mount its own `POST` endpoint outside `/__ops/api/`. |
| spec-29 | §6 integration shape | **Preserve and reference**: ops-api `/scopes/:scope/stream` is the canonical Worker fetch integration of spec-29. |
| spec-34 | §5 standard projections | **Preserve**: spec-35 endpoints are the HTTP form of these projections. |

---

## 9. Open questions

1. **[Open] When does `ops-react` become a thing?** Trigger = N≥2 deploying apps want a default ops UI. zeroY3 and vibe-coding-web both have workbench UIs, but those are **app workbenches**, not ops-react. ops-react ships when an actual ops persona (not a product user) needs a default substrate dashboard.

2. **[Open] Per-tenant rate limiting and stream timeout on ops-api itself.**
   If a single ops principal hammers `/stream` across many scopes, ops-api
   Worker can exhaust its concurrent-connection budget. v0 ships no timeout
   or cap; the previously sketched `maxStreamSeconds` option was removed
   because the implementation never enforced it (false operational guarantee).
   Setting a real timeout and a stream-capacity error code is deferred
   until first deployment hits the limit.

3. **[Open] Large-scope `/scopes` pagination + auth-scoped listing.** v0
   has no cursor on `/scopes` because filter-after-fetch hides authorized
   scopes behind unauthorized pages. The graduation path is making the
   resolver take the principal and pre-filter (`list(principal, filter)`),
   which trivially supports cursor pagination once `authorize` is folded
   into the resolver. Trigger when N scopes per tenant exceeds ~1000.

4. **[Open] OpenTelemetry / tracing emission from ops-api.** ops-api itself is a Worker; its own request traces could go through `cap_dispatch` of an `ops` scope. v0 does not implement this; v0.x may.

5. **[Open] Bulk scope authorization optimization.** If `scopeResolver.list()` returns N=10k scopes and authorize is one-per-scope, `/scopes` is O(N) authorize calls. Apps with this scale will need a `OpsAuth.authorizeMany(principal, scopes, action)` extension. v0 does not add it.

---

## 10. Validation

This spec lands as a doc-only commit. Implementation lands in a separate commit (`feat(ops-api): mount minimal ops api`). Implementation must satisfy §6's nine acceptance items + typecheck + test in the `@agent-os/ops-api` package.

ops-api v0 takes no dependency on:

- spec-34 §7.2 positive ExtensionCapability (ops-api writes nothing).
- spec-30 cross-scope fan-in (intentionally absent).

ops-api v0 **adds** one method to AgentDOBase's standard projection
surface: `runs(spec): Promise<RunListPage>` (spec-34 §5). This is not a
new substrate capability; it is the SSoT-correct location of the run-list
projection that v0 ops-api requires. Synthesizing the list inside ops-api
from `events()` does not work — the event-level cursor truncates the
newest runs first under any reasonable batch cap.
