# Spec 29: ledger event stream with cursor

> **Status**: Draft v0 (drafted 2026-05-26)
> **Depends on**: [spec-24 §3.1 SSoT discipline](./spec-24-invariants-and-surface.md), [spec-28 §2 dispatch envelope](./spec-28-img-gen-gap-implementation-plan.md)
> **Pressure evidence**: vibe-coding-web `packages/runtime/src/lib/sse.ts` hand-rolls SSE pump + heartbeat; `apps/default/src/agent-runs/consumeAgentStream.ts` hand-rolls frame splitting and UI state hydration. The forge recurs in any browser-facing agent app.
> **Does not deliver**: an app-level event vocabulary (`AgentStreamEvent` / `chat.delta` / `tool.tree`). The wire is `LedgerEventRpc`; richer projections belong to the app frontend.

---

## 0. Purpose

Make in-flight ledger state observable from outside the DO **without
forging a second protocol**. Today an app that wants to show the agent
working in real time must:

1. write its own SSE pump (`Response` + `ReadableStream` + heartbeat),
2. invent an in-flight event vocabulary on top of ledger rows,
3. handle reconnect / replay without ledger-side cursor semantics,
4. solve the live-vs-snapshot race itself (subscribe-then-backfill loses
   events; backfill-then-subscribe duplicates them).

`(1)` and `(2)` are coupled: the app names its own wire schema because
the ledger offered no stream surface, then frontend hydration code grows
around that schema. Both vanish if the substrate streams ledger rows
directly under an id-cursor.

This spec defines that primitive. Nothing more.

---

## 1. Invariant

> **The wire is the ledger. `streamEvents` emits `LedgerEventRpc` rows
> ordered by `(ts, id)`, identified by `id`. Any richer event vocabulary
> (UI deltas, tool trees, run status pills) is an app-side projection
> over this stream — not a substrate concern.**

Corollaries:

- **C-1.** Stream items carry `id` (SQLite INTEGER PRIMARY KEY
  AUTOINCREMENT). The id is the cursor. Timestamps are not unique within
  a millisecond (same problem as spec-25 §7.2 projectLease); `(ts, id)`
  total ordering is the only correct cursor.
- **C-2.** No event is lost and no event is duplicated for a connection
  that supplies a valid `afterId`. This is by-construction (§3.2), not
  best-effort.
- **C-3.** Reconnect after disconnect is a normal case, not a special
  case. The client resumes from the last `id` it saw. SSE's
  `Last-Event-ID` header is the transport for this; the substrate
  reads it as `afterId`.
- **C-4.** Filtering happens server-side by `kind` set. Anything richer
  (regex, payload predicates, scope hierarchy) is app-side. The wire
  primitive must stay narrow or it grows into a query language.

---

## 2. Public surface

Two methods on `AgentDOBase`, both scoped to the DO instance:

```ts
class AgentDOBase {
  /** Cursor-paginated snapshot read. Pure projection over the events
   *  table. Returns rows with id > afterId, oldest first, up to limit.
   *  No live tail; for that see streamEvents below. */
  events(opts?: {
    afterId?: number;        // default 0 (from the beginning)
    limit?: number;          // default 1000; cap implementation-defined
    kinds?: ReadonlyArray<string>;
  }): Promise<ReadonlyArray<LedgerEventRpc>>;

  /** Live tail. Returns an HTTP Response object with SSE body. Caller
   *  forwards it from a Worker fetch handler. The DO holds the
   *  connection for the lifetime of the stream; closing is normal. */
  streamEvents(opts?: {
    afterId?: number;        // default: read from request Last-Event-ID
                             // header at the call site, else 0
    kinds?: ReadonlyArray<string>;
    heartbeatMs?: number;    // default 15000; keep middleboxes from
                             // idle-closing the connection
  }): Response;
}
```

### 2.1 `events()` semantics

Pure projection. No live subscription, no buffering. Implementation:

```sql
SELECT id, ts, kind, scope, payload
FROM events
WHERE scope = ?
  AND (?afterId IS NULL OR id > ?afterId)
  AND (?kinds IS NULL OR kind IN (?kinds))
ORDER BY id ASC
LIMIT ?limit;
```

Stable axis: `events()` is the only read API needed by app code that
wants a snapshot — for example a fresh page load before opening a
stream. `submit-agent.ts`'s existing `ledger.events(scope)` is the
internal projection version; `AgentDOBase.events()` is the public
filtered/paginated form.

### 2.2 `streamEvents()` semantics — wire format

Returns a `Response` object the caller exports from a fetch handler:

```http
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
```

Body framing per event:

```
id: <ledger.id>
event: ledger
data: <JSON of LedgerEventRpc>

```

Where `LedgerEventRpc` (defined in `packages/core/src/types.ts`) is:

```ts
{ id: number; ts: number; kind: string; scope: string; payload: unknown }
```

Heartbeat frames between live events:

```
: keepalive

```

`:` lines are SSE comments; clients ignore them; middleboxes see traffic.

**Wire shape is closed.** This spec does NOT carry app-vocabulary
events (`chat.delta`, `tool.tree`, `run.status`). Apps build those
client-side from the ledger stream. The substrate ships one event type
on the wire: `ledger`.

### 2.3 Reconnect

`Last-Event-ID` request header → `afterId`. SSE's native semantics; no
custom protocol. Sequence:

1. Browser `EventSource` opens connection.
2. Server reads `Last-Event-ID` from request headers; if present and
   parses to integer, use as `afterId`. Else use `afterId` from method
   call options. Else 0.
3. Stream proceeds per §3.

If the connection drops, `EventSource` automatically reopens with
`Last-Event-ID` set to the last id it received. No app code required.

---

## 3. Algorithm — race-free tail

The naive shape ("subscribe, then read snapshot, then go live") has a
window where events fire between snapshot SELECT and subscription
attach, dropping them. The reverse ("subscribe first, then read
snapshot") double-delivers everything that landed during the SELECT.

Correct algorithm uses **subscribe-first plus id-watermark dedup**:

```
streamEvents(afterId, filter):
  watermark = afterId
  liveQueue = []                                        # in-memory buffer

  # ── step 1: register the subscriber BEFORE any read ──
  handler = (event) => liveQueue.push(event)
  on(handler, kinds=filter)

  # ── step 2: snapshot what's already committed ──
  snapshot = SELECT id, ts, kind, scope, payload
             FROM events
             WHERE scope = self.scope
               AND id > afterId
               AND (filter IS NULL OR kind IN filter)
             ORDER BY id ASC

  # ── step 3: emit snapshot, advancing the watermark ──
  for ev in snapshot:
    emit_sse(ev)
    watermark = max(watermark, ev.id)

  # ── step 4: drain liveQueue, dedup against the snapshot ──
  while liveQueue:
    ev = liveQueue.shift()
    if ev.id > watermark:
      emit_sse(ev)
      watermark = ev.id

  # ── step 5: switch to live; same dedup guard ──
  handler := (event) =>
    if event.id > watermark:
      emit_sse(event)
      watermark = event.id

  # ── plus a heartbeat timer ──
  setInterval(() => emit_keepalive(), heartbeatMs)
```

### 3.1 Why this works

Invariant: **every committed row with `id > afterId` is emitted exactly
once.**

Three windows during stream startup:

| Window | Where the event lands | Where it's emitted from |
|---|---|---|
| Before subscription | snapshot SELECT (sees committed state) | step 3 |
| Between subscribe and snapshot | BOTH liveQueue AND snapshot | step 3 emits; step 4 dedups |
| After snapshot completes | liveQueue only | step 4 / step 5 |

The id watermark monotonically increases. `id` is unique per DO (SQLite
INTEGER PRIMARY KEY AUTOINCREMENT) and totally ordered by INSERT
sequence. Two rows can share a `ts` but never an `id`. This is the same
total-ordering invariant spec-25 §7.2 already relies on.

### 3.2 What this rules out

- **Lost events.** Subscribing AFTER reading the snapshot would miss
  events that committed in between. We subscribe first.
- **Duplicate events.** Emitting both snapshot and queue without dedup
  would deliver the overlap twice. The watermark check skips dups.
- **Reordering across the snapshot→live boundary.** Both halves emit in
  ascending id; the watermark prevents going backward.

### 3.3 Implementation notes (non-normative)

- `on()` is already in `AgentDOBase`; the only addition is letting the
  handler push into a per-stream queue rather than fire app handlers.
- The SSE Response uses a `ReadableStream` controller; close on caller
  disconnect (detect via `AbortSignal` on the request).
- Heartbeat is a `setInterval` that writes `: keepalive\n\n` to the
  controller. Cleared on close.
- Memory cap on `liveQueue`: in v0 the drain loop runs synchronously
  after the snapshot in the same effect, so the queue is bounded by
  events committed during the SELECT. Real-world this is <100 rows.
  If a future implementation makes drain async, add an explicit cap and
  close the stream on overflow rather than silently losing.

---

## 4. Filter semantics

`kinds: ReadonlyArray<string>` — exact-match set membership on
`event.kind`. No prefix matching, no glob, no regex. v0 keeps it narrow.

Server-side filter pushes through to:

- SQL `WHERE kind IN (?, ?, ...)` in `events()` and the snapshot
  SELECT;
- The `on()` registration filter at the DO scope (it already supports
  per-kind subscription).

Empty / undefined `kinds` = no filter, every kind is delivered.

If apps need richer filtering (prefix, payload predicate), they filter
client-side. v0 does not grow the wire.

---

## 5. Boundary: what this spec does NOT do

- **No app-level event vocabulary.** Wire ships `LedgerEventRpc` rows;
  any `AgentStreamEvent` / `delta` / `tool-tree` framing is app code.
  vibe-coding-web's current SSE schema is exactly the kind of thing
  this spec does NOT carry — it gets reduced to "frontend projection
  over `kind: 'llm.response'` etc rows."
- **No authentication / authorization.** The Worker fetch handler that
  forwards the Response is where auth checks live. The DO trusts its
  scope.
- **No WebSocket / bi-directional.** SSE is half-duplex (server →
  client) and matches the ledger-tail shape exactly. WS is rejected for
  v0 because no app evidence requires client → server over the same
  channel — apps use HTTP POST to write back, which is what they
  already do.
- **No cross-scope subscription.** `streamEvents()` is per-DO, the
  scope inherent. Watching multiple scopes from one client = multiple
  EventSource connections, or an app-side proxy that fans in.
- **No replay window cap / retention.** Ledger is the SSoT; whatever
  rows still exist are streamable. If an app caps retention via barrier
  events (spec-25 §8.1 invalidate is the closest pattern), the stream
  naturally reflects what's left.

---

## 6. Public surface — apps

App worker fetch handler example (the only non-trivial integration):

```ts
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname.match(/^\/sessions\/[^\/]+\/events$/)) {
      const sessionId = url.pathname.split("/")[2];
      const id = env.SESSION.idFromName(sessionId);
      const stub = env.SESSION.get(id);

      // The DO method synthesizes the Response; Worker just returns it.
      const afterIdHeader = req.headers.get("Last-Event-ID");
      const afterId = afterIdHeader ? Number(afterIdHeader) : 0;
      return stub.streamEvents({ afterId });
    }
    // ... other routes
  },
};
```

Browser side:

```ts
const source = new EventSource(`/sessions/${id}/events`);
source.addEventListener("ledger", (ev) => {
  const row = JSON.parse(ev.data) as LedgerEventRpc;
  // app folds row.kind / row.payload into UI state.
});
// Reconnect is automatic; Last-Event-ID is sent natively.
```

That's the whole shape on both sides.

---

## 7. Acceptance

Contract tests in `packages/core/test/event-stream-contract.test.ts`:

### 7.1 Race-free invariant

- emit N events synchronously, then call `streamEvents`; verify all N
  arrive (no loss from "subscribe-after-snapshot" anti-pattern).
- emit N events interleaved with the `streamEvents` open; verify each
  event arrives exactly once (no dup from snapshot-overlap-queue
  anti-pattern).
- emit events DURING the snapshot SELECT (simulate by an artificial
  delay); verify they arrive once after the snapshot drain.

### 7.2 Cursor + reconnect

- open stream with `afterId: 5`; expect only events with id > 5.
- open stream with no `afterId` and Last-Event-ID header = "5"; same
  result.
- close stream after N events, reopen with Last-Event-ID = N; expect
  resume from id N+1, no overlap.

### 7.3 Filter

- emit events of kinds A, B, C; stream with `kinds: ["A", "C"]`;
  expect only A and C.
- empty `kinds` = no filter.

### 7.4 Heartbeat

- with `heartbeatMs: 50`, open stream, wait 200ms with no events;
  expect ≥ 3 heartbeat comment frames.

### 7.5 SSE wire shape

- every data event has `id:` line matching the row id.
- every data event has `event: ledger`.
- `data:` JSON parses to a valid `LedgerEventRpc`.
- heartbeat frames start with `:`.

### 7.6 `events()` snapshot

- `events({afterId: 0})` returns all rows; `events({afterId: N})`
  returns only id > N.
- `events({limit: K})` returns at most K rows, in ascending id order.
- `events({kinds: [...]})` filters by exact-match kind set.

---

## 8. Versioning

- v0 surface frozen per this spec.
- Adding new SSE event types (beyond `ledger`) requires a wire bump
  and is a major spec change.
- Filter-shape extensions (prefix, payload predicate) are major spec
  changes: they grow the wire into a query language and must be
  justified by 2+ apps showing the same forge.
- WS/bidirectional support is a separate spec (29.5? Or 33?). Not on
  the v0 trajectory.

---

## 9. Open questions

1. **Per-DO connection limit.** A single DO is single-threaded; many
   open streams compete for tick budget. v0 makes no limit; if a real
   app hits the wall, add a `streamEvents` connection cap or a queue
   handoff to a worker per stream. Not in scope until observed.

2. **Cross-scope fan-in.** An admin dashboard wanting to watch all DO
   instances of a class can't do that with this primitive (per-DO
   only). Workarounds today: open one EventSource per scope; or app
   builds a fan-in proxy. Substrate could add a fan-in primitive in a
   later spec — pressure evidence required.

3. **Payload size / chunking.** A `tool.executed` row with megabytes of
   output blows up the SSE frame. v0 leaves it to apps to cap payload
   size (or write a carrier ref into the row instead — see spec-30
   long-running cookbook). Stream does not chunk a single payload across
   multiple frames.

4. **Server-Timing for observability.** Each SSE frame could carry a
   `Server-Timing` extension header noting projection latency. Useful
   for debugging stream-source contention. Not in v0; add if dispatch
   trace context (spec-28 §2.5) shows the inverse need.

---

## 10. Decision provenance

| Decision | Origin |
|---|---|
| Wire = `LedgerEventRpc`, not app vocabulary | spec-29 review 2026-05-26: vibe-coding-web's `AgentStreamEvent` schema is what the substrate is replacing, not extending |
| Cursor = ledger `id`, not timestamp | spec-25 §7.2 already established `(ts, id)` total ordering; reusing `id` keeps the algebra coherent |
| Subscribe-first + dedup, not subscribe-after | Codex 2026-05-26: subscribe-after has an unavoidable lost-events window |
| SSE not WebSocket | Half-duplex matches the tail shape exactly; no app forge for WS today |
| Per-DO scope only | spec-24 INV's "one scope, one writer" boundary already governs reads |
| `events()` snapshot AND `streamEvents()` tail as separate methods | Pure projection vs IO-bearing live tail are different effect types; merging them hides the distinction |
| `Last-Event-ID` reconnect, no custom protocol | SSE native; one less protocol for apps to learn |

---

## Appendix A: vibe-coding-web pressure evidence

Files this primitive replaces (substrate-side):

- `packages/runtime/src/lib/sse.ts` — manual `Response` + ReadableStream
  + heartbeat builder. Equivalent to §2.2 wire format.
- `apps/default/src/agent-runs/consumeAgentStream.ts:39–51` — manual
  frame splitting and frontend hydration. With this spec, becomes a
  ≤5-line `EventSource` plus a `row.kind` switch.

Files NOT replaced (correctly app-domain):

- `apps/default/src/agent-runs/agentStreamReducer.ts` (hypothetical) —
  whatever projects `LedgerEventRpc` rows into UI state. The wire is
  raw rows; the projection is the app's design surface.
- All `chat.delta` / `tool.tree` / `run.status` UI events. Built
  client-side from `kind: "llm.response"`, `kind: "tool.executed"`,
  etc. The substrate emits only the raw kind; the UI builds the
  vocabulary.

This split (wire = ledger, projection = app) is the same split spec-25
already makes for capability evidence: `events` is SSoT, `CapabilityLease`
is a projection. The same discipline applies one level up at the UI
boundary.
