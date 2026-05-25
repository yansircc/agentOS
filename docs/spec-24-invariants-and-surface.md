# Spec 24: agent-OS Invariants and Surface

> **Status**: Draft v0 (frozen on N=4 dogfood derivation + spike-01/02 validation)
> **Date**: 2026-05-25
> **Supersedes**: nothing (clean slate, not migrating from `vibe`)

---

## 0. Purpose

agent-OS is the minimum declarative substrate for building agent-capable apps on Cloudflare.

Its existence is justified by one observation, surfaced across 4 dogfood repos:

> **8+ projects, when forced to add agent capability without agent-OS, each rewrite the same ~50% of infrastructure**: ledger, queue, outbox, retry, idempotency, ops dashboard, tool dispatch loop, context window management, identity scoping, reservation patterns, etc.

agent-OS captures only the algebra of that recurring infrastructure. Business logic, UI, integrations, and domain schemas remain in app land.

---

## 1. Meta-rule (decision filter)

> **Symmetric duals. Sharp boundaries. Conservative defaults. Orthogonal composition.**
>
> Conflict resolution:
> - at the **algebra layer**, duality wins (a missing dual is a bug)
> - at the **feature layer**, minimalism wins (avoid shipping until N apps need it)

Every API decision in this spec was filtered through this rule. Where it fails to decide,
the question is marked **[Open]** and waits for spike or N+1 evidence.

---

## 2. Invariants (10)

| # | Invariant | Rationale |
|---|---|---|
| **INV-1** | No business UI. May ship optional **infrastructure observability UI** (must be opt-out). | Business UI ≠ infrastructure UI. Boundary criterion: does the UI reference app-specific concepts? |
| **INV-2** | Serves the "agent reasoning closed loop" only. | Anything outside `project(ledger) → propose dispatch intent` is out of scope. |
| **INV-3** | "Pre-grant + consume" patterns unify into **Quota**. Reactive face = `on / scheduleEvent / view.reflective`. | billing / rate-limit / token-budget all have identical algebra; unify or rebuild. |
| **INV-4** | What CF ships, we do not rewrite. Thin unifying naming is allowed when 4+ CF surfaces serve the same role. | Reactive wrapping (`on`) and LLM-carrier wrapping (`submitAgent` over Responses API) are the only two unifications. |
| **INV-5** | State ownership and agent boundary are invariants (see §3, §4). | These are not implementation details; they define what "agent" means. |
| **INV-6** | v1 supports only **CF AI** (`env.AI.run` + AI Gateway). No BYOK. | Locks dependency surface, gets unified billing + cache + retry free. v2 may relax. |
| **INV-7** | Built on the **CF Agents framework** (`extends Agent`, Session API). | Bets on CF Agents lifecycle, hibernation, naming, SQLite. Accept experimental risk. |
| **INV-8** | No BYOK third-party API keys. | Reduces credential surface; lock-in cost accepted. |
| **INV-9** | `sandbox / workspace / browser` are **stateful dispatch carriers**, addressed by scope id. Their state lives in the carrier, not the ledger. | Carrier ≠ ledger. Stateful carriers must explicitly publish their scope id. |
| **INV-10** | Serves **agent modules only**. Non-agent parts use plain CF Workers. Two parts collaborate via **Service Bindings**. Multi-worker is the default deployment topology. | Embedded mode is rejected; "agent + CRUD in one worker" is an anti-pattern. |

---

## 3. State ownership

| Type | Owner | Backing |
|---|---|---|
| **ledger state** (append-only events of truth) | agent-OS ledger primitive | DO SQLite, optionally D1 |
| **derived state** (`project()` output) | nobody — recomputed | pure function over ledger |
| **external state** (WP / Stripe / customer ERP) | app | cached into ledger via `RemoteView` carrier |

There is no "transient state". CF Workflows persists all `step.do` inputs/outputs into SQLite,
which means even mid-step state is technically ledger. Three categories above are exhaustive.

### 3.1 SSoT discipline (derived from Symphony comparison)

The only table that is **ledger truth is `events`**. The DO carries other
tables but they are NOT ledger:

| Table | Role | SSoT? |
|---|---|---|
| `events` | append-only ledger | **yes** |
| `scheduled_events` | pending intent buffer between `scheduleEvent()` and alarm fire; fires INTO `events` then is observable only as the resulting event | no |

Counters like quota consumption are **not stored**. They are projected over
`events WHERE kind='dispatch.consumed'` inside the same `transactionSync` as
the consume write, so quota read-modify-write is atomic by construction
(no separate quota table to race with the ledger).

`view.reflective.*` (§5.1) is similarly projection — no backing storage.

This rules out the most common substrate failure: a second writer to a
derived counter that drifts from the ledger.

---

## 4. Agent capability boundary

```
agent : project(ledger) → dispatch(intent)
        ─────────────    ───────────────
         pure read         pure proposal

CAN:
  - read ledger via project(view, source)
  - propose dispatch intent

CANNOT:
  - write ledger directly  (must go through dispatch carrier or ingest channel)
  - hold cross-invocation in-memory state  (memory ∈ ledger, else lost on workflow restart)
  - read external world directly  (must dispatch a read_tool, ingest result, then project)
  - execute side effects directly  (only dispatch carrier executes)
```

**Corollary**: `agent.run` is a **pure function** of the ledger snapshot.
Replayable + sandboxable + auditable for free.

---

## 5. Core surface

### 5.1 Four algebra ops

```ts
// Spatial duality (in / out boundary)
ingest(channel, payload)   → log(event)
dispatch(carrier, intent)  → effect + log(event)

// Temporal duality (write / read history)
log(event, scope, tier?)   → ledger
project(view, source?)     → readonly

// Reactive face (time-axis observability + scheduling)
on(eventKind, handler)              // ledger subscribe (same-scope only in v1)
scheduleEvent({ at, event, data })  // delayed log
view.reflective.{agentRuns,currentBudget,currentQuotaState}  // agent self-introspection
```

Cross-scope `on()` is not supported in v1 (DO isolation boundary). App must forward
via queue or Service Binding.

### 5.1.1 Lifecycle vocabulary

Inside one `submitAgent` invocation the substrate distinguishes four nested terms:

| Term | Definition | Spans |
|---|---|---|
| `AgentRun` | one `submit()` invocation | 1..N `LlmTurn` until budget / retries exhaust or LLM stops emitting tool calls |
| `LlmTurn` | one provider call | emits 0..N `ToolCall` |
| `ToolCall` | one carrier dispatch within an `LlmTurn` | carries `attempt: number` field for retries |
| `Continuation` | subsequent input on the same `AgentRun` after suspend/resume (spike-2: `step.waitForEvent`) | — |

`LiveSession` (the long-lived agent subprocess concept from Symphony) is
**absent by construction**: CF Workers has no long-running process.
INV-7's CF Agents framework Session API handles cross-turn state
(history compaction, hibernation) without exposing a process lifetime.
The four terms above are exhaustive for v1.

### 5.2 `submitAgent` — the declarative entry

```ts
function submitAgent<C, O>(spec: {
  intent:    string;                              // human-readable goal
  context:   Record<string, View>;                // one-shot snapshot projection
  agent:     { provider: ProviderId; model: ModelId };
  tools:     Record<string, Carrier>;             // schema auto-translated for LLM
  budget: {
    tokens?:   number;                            // hard cap
    cost?:     Quota;                             // pre-grant via Quota
    time?:     Duration;                          // hard cap
    maxTurns?: number;                            // LLM loop iteration cap
    toolRetries?: number;                         // per-tool retry attempts
  };
  composer?: (intent, ctx, tools) => Message[];   // optional prompt override
  deliver:   { event: EventName };                // scope is structurally
                                                  // owned by the DO instance
                                                  // (derived from ctx.id.name)
}): Promise<{ run_id: string }>;
```

**No `done` predicate.** The loop terminates on three invariants only:

1. LLM returns no more tool calls (provider-natural stop)
2. Any `budget` dimension exhausted
3. Tool dispatch retry exhausted

Business validation is the app's responsibility — it subscribes via
`on(deliver.event, handler)` and resubmits if unhappy.

**Context is snapshot, not reactive.** Captured at submit time, frozen for the whole loop.
This guarantees `agent.run` replayability.

### 5.3 `AgentDO` — the base class

Every agent-OS app uses one DO class derived from CF Agents' base:

```ts
export class AgentDO extends Agent<Env, State> {
  // ledger primitives (private)
  // submitAgent loop
  // on() handler registry
  // scheduleEvent via this.schedule()
  // Session API integration for LLM history compaction
}
```

App-side wrangler binding:

```jsonc
{
  "durable_objects": { "bindings": [{ "name": "AGENT_DO", "class_name": "AgentDO" }] },
  "migrations":      [{ "tag": "v1", "new_sqlite_classes": ["AgentDO"] }]
}
```

Instance addressed by `env.AGENT_DO.idFromName(scope)`. Scope key is a string,
semantics owned by app (§8).

### 5.4 Admin Query HTTP API

`/__ops/api/*` is **invariant**. The HTTP endpoints expose the ledger as JSON for
ops UI (or any client). React UI package is opt-in (see §12).

```
GET  /__ops/api/runs?scope=...        list submitAgent runs
GET  /__ops/api/runs/:runId           one run's full trace
GET  /__ops/api/events?scope=&kind=   ledger event explorer
GET  /__ops/api/workflows?status=     CF Workflow instances by status
POST /__ops/api/workflows/:id/event   trigger a waitForEvent (approval)
GET  /__ops/api/quota?key=...         current quota state
GET  /__ops/api/cost?scope=&model=    AI Gateway cost rollup
```

---

## 6. Carrier middleware

One middleware ships in core (`withQuota`). `withStructuredOutput` was
prototyped against Workers AI JSON Mode and reverted before v0.2.9 —
see [notes/structured-output-exploration.md](./notes/structured-output-exploration.md)
for design + spike-03 evidence + resume conditions.

### 6.1 `withQuota(carrier, spec)` — unified pre-grant + consume

```ts
type Quota<K, M> = {
  key:        (intent) => K;                       // user_id | scope | channel_instance
  window:     "∞" | { duration: ms };              // ∞ = billing; duration = rate-limit
  measure:    (effect) => M;                       // count=1 | bytes | tokens | cost_cents
  limit:      M | (() => M);                       // constant OR dynamic (e.g. balance from project)
  refundable: boolean;                             // billing yes, rate-limit no
};
```

All "pre-grant + consume" patterns are Quota instances:

| Pattern | Quota instance |
|---|---|
| Credit billing | `Quota<user_id, ∞, cost_cents>`, dynamic limit |
| Per-user rate limit | `Quota<user_id, 60s, count>` |
| Per-conversation token budget | `Quota<conv_id, ∞, tokens>` |
| WhatsApp API rate | `Quota<channel_instance, 1s, count>` |

Hit → `log("dispatch.rate_limited" | "quota.exceeded")` + reject.
Queue is **not** built in; app composes with `scheduleEvent` if needed (orthogonality).

### 6.2 `withStructuredOutput(carrier, schema)` — **[Deferred from v1 MVP]**

Explored and reverted before v0.2.9. Workers AI JSON Mode is best-effort
(model may fabricate fields, schema not contractually enforced), and no
current reference app needs typed LLM output. Design + spike-03 evidence
preserved in [notes/structured-output-exploration.md](./notes/structured-output-exploration.md).

Resume condition: first reference app surfaces a real structured-output
need, OR Cloudflare ships a Workers AI model with contractual JSON Schema
enforcement.

**`withFallback` and `withIdempotency` are NOT shipped** — CF AI Gateway provides
fallback natively; CF Workflows `step.do` provides idempotency natively.

---

## 7. Standard failure event vocabulary

Standardized so apps can `on(kind, handler)` precisely. Namespace `agent.aborted.*`
is reserved; app extensions use `agent.aborted.app.*`.

```
agent.aborted.budget_tokens       budget.tokens exhausted
agent.aborted.budget_cost         budget.cost (Quota) exhausted
agent.aborted.budget_time         budget.time exceeded
agent.aborted.retries             tool retry exhausted
agent.aborted.tool_error          tool carrier threw
agent.aborted.user_cancel         external cancel via stub.cancel()
agent.aborted.upstream_failure    AI Gateway / provider returned 5xx after retries
dispatch.rate_limited             Quota window-based reject
quota.exceeded                    Quota unbounded reject (insufficient balance)
agent.aborted.app.{...}           app-defined namespace
```

These are ledger events (kind strings), not exceptions. Loop termination *always*
results in one of these or a deliver event. Never silent.

---

## 8. Standard scope key conventions

Scope key is a `string`. agent-OS does not validate the format, only uses it as
DO `idFromName()` input. Convention (recommended, not enforced):

```
user/{userId}                     per-user state
org/{orgId}                       per-organization state
thread/{threadId}                 per-conversation
agent/{agentName}/{itemId}        per-agent-internal item
session/{sessionId}               per-session (e.g. interview)
wp/{pluginId}@{siteDomain}        cross-system bridges
```

Cross-scope event ordering is undefined (DO isolation). Same-scope events are
totally ordered by SQLite insert order.

---

## 9. View source plurality

The `project(view, source)` source is pluggable. agent-OS recognizes these built-in
sources; each adds zero new algebra, just a thin adapter:

| Source | Use | Package |
|---|---|---|
| `do-sqlite` (default) | business state, ledger | core |
| `analytics-engine` | high-volume low-value trace / metric / audit | core (via `log` tier hint) |
| `d1` | app's business schema | `@agent-os/view-d1` |
| `kv` | cached views | `@agent-os/view-kv` |
| `r2` | blob metadata / listing | `@agent-os/view-r2` |
| `hyperdrive` | external Postgres (customer ERP) | `@agent-os/view-hyperdrive` |
| `autorag` | semantic retrieval | `@agent-os/kb-autorag` |
| `vectorize` | vector retrieval | `@agent-os/view-vectorize` |
| `http` | arbitrary remote API | `@agent-os/view-http` |

---

## 10. Log tier (hint, not invariant)

```ts
log(kind, payload, scope);                      // default → DO SQLite
log(kind, payload, scope, { tier: "metric" });  // → Analytics Engine
```

DO SQLite is OLTP (ACID, fast small writes). Analytics Engine is OLAP (write-heavy,
sample-based query, near-infinite scale). The two have different cost / latency curves;
**doc must warn**: ops dashboard data > 1M events should live in AE, not SQLite.

Tier is a **hint** (default sane). Strict per-event tier declaration would force apps
to know the future query pattern at write time — bad ergonomics.

---

## 11. Extensions (opt-in, thin)

```
@agent-os/core             ← required (4-op + AgentDO + submitAgent + middleware)
@agent-os/ops-api          ← invariant /__ops/api/* (mounted by app)
@agent-os/ops-client       ← typed hooks for ops data (opt-in)
@agent-os/ops-react        ← default observability UI (opt-in)

@agent-os/cf-tools         ← sandbox / workspace / browser carriers
@agent-os/kb-autorag       ← AutoRAG view source
@agent-os/http-channel     ← httpJsonAdapter ingest pattern
@agent-os/audit-export     ← ledger export utility
@agent-os/view-*           ← view source per CF service

@agent-os/identity         ← strong-key identity resolution (B2B)
@agent-os/envelope         ← capability envelope schema-typed dispatch
@agent-os/approval-inbox   ← waitForEvent + UI helper
@agent-os/billing-7pay     ← 7Pay integration
@agent-os/billing-stripe   ← Stripe integration
@agent-os/billing-credits  ← ledger event schema for credit flows
```

Each extension target ≤ 100 lines of glue. Heavier than that = sign of CF service
being under-used.

### 11.1 Stateful carrier safety constraints

INV-9 establishes that **stateful carriers** (sandbox, workspace, browser, and
any future state-holding dispatch carrier) keep their state inside the carrier
addressed by scope id — not in the ledger. Concretely, a carrier package such
as `@agent-os/cf-tools` MUST satisfy these constraints; the agent loop and
shared utilities MAY rely on them:

| # | Constraint | Failure if violated |
|---|---|---|
| C1 | **Declare a state root** keyed by scope id (e.g. `/sandbox/{scope}/`, `workspace://${scope}`). The root is the carrier's promise that state outside it is not its concern. | Two carriers can collide on the same physical resource; cleanup ambiguous. |
| C2 | **Validate path containment** on every path-taking operation: the resolved absolute path MUST be within the declared root, with symlinks resolved. Reject otherwise. | Path traversal (`../../etc/passwd`) escapes the scope boundary; one tenant reads another. |
| C3 | **Publish a cleanup primitive** keyed by scope id (e.g. `releaseScope(scope)`), invoked when the owning DO is deleted or the carrier is retired. | Deleted scopes leak carrier state; long-term cost growth + privacy risk. |
| C4 | **Do not expose carrier-internal filesystem / session shape to shared logic.** Shared code MAY pass paths and scope ids into the carrier; it MUST NOT branch on whether the carrier's state is filesystem-backed, object-store-backed, or in-memory. | Boundary leak — the carrier becomes a hidden coupling point; replacing one carrier breaks unrelated code. |

These constraints are conditions on **carrier implementations**, not on the
§5 core algebra. Each shipped carrier in `@agent-os/cf-tools` includes a
conformance check exercising C1–C4 against its own primitives.

---

## 12. CF services mapping

| Use directly (zero wrapping) | Why |
|---|---|
| CF Workflows + step.do/sleep/waitForEvent | suspendable agent loops, outbox guarantee |
| CF AI Gateway | LLM routing + cache + retry + fallback + cost |
| Workers AI (env.AI.run) | unified binding to 70+ models |
| AI Search / AutoRAG | KB retrieval |
| Vectorize | vector retrieval |
| CF Agents framework (Agent base, Session API) | DO addressing + hibernation + history compaction |
| Sandbox SDK (@cloudflare/sandbox) | exec / runCode / fs / snapshots / outbound policy |
| Workspace (@cloudflare/shell) | durable virtual filesystem |
| Browser Run | headless Chromium for agents |
| Workers Subscriptions / Better Auth | identity (out of scope for agent-OS) |
| Outbound Worker | sandbox egress policy |
| Hyperdrive | external Postgres pool |
| Analytics Engine | high-volume audit/metric ledger tier |
| Service Bindings + typed RPC | multi-worker collaboration |
| Queue / Cron / DO / D1 / R2 / KV | direct bindings, no abstraction |
| WfP dispatch namespace | tenant isolation (v2 third-party apps) |

agent-OS never reimplements any of the above.

---

## 13. Multi-worker topology (INV-10 elaboration)

Default architecture for non-trivial apps:

```
www-frontend                   (TanStack Router + React, presentation only)
       │
       ├──────────────────────────────┐
       ▼                              ▼
   AGENTIC WORKERS                NON-AGENT WORKERS
   (Native agent-OS)              (plain CF Workers + Hono + Drizzle)
   ────────────────               ──────────────────
   wa-cs-agent      ~300 LOC      billing-worker    ~1000 LOC
   image-gen-agent  ~300 LOC      identity-worker   ~800 LOC
   acf-agent        ~300 LOC      asset-worker      ~500 LOC
       │                              │
       └──────── Service Binding ─────┘ (typed RPC, both directions)

   Shared infrastructure:
     AGENT_OS_LEDGER       — DO SQLite cluster (per agent worker or shared)
     AGENT_OS_OPS          — admin worker mounting @agent-os/ops-react
     CF: AI Gateway / AutoRAG / R2 / Workflows / Sandbox / Cron / Hyperdrive
```

agent + CRUD in the same worker is an anti-pattern. If module count grows large enough
to want shared deployment, prefer Service Binding across workers over monolith.

---

## 14. Internals: Effect TS

agent-OS **internals** use Effect TS (Schema for envelope, Layer for carrier composition,
typed errors for failure vocabulary). agent-OS **public API** is plain TS async/Promise.

```ts
// public API: zero Effect leakage
const { run_id } = await submitAgent({ ... });

// app may wrap into Effect if it wants (one line)
const eff = Effect.tryPromise(() => submitAgent({ ... }));
```

### 14.1 Implementation must follow `effect-ecosystem` skill rules

Internal code **must comply with all EFF001–EFF032** rules
(see `agent-skills/plugins/agent-skills/skills/effect-ecosystem/`).
Key consequences for agent-OS core:

| Rule | Implication for agent-OS core |
|---|---|
| **EFF002/003/004** | No `async function`, no `await`. Use `Effect.gen(function* () { yield* ... })` everywhere. |
| **EFF001/024/025** | No `try/catch`, no `throw new Error`. Use `Effect.try / Effect.tryPromise` + `Data.TaggedError` subclasses. |
| **EFF005** | No `Promise.all / Promise.race`. Use `Effect.all({ concurrency })` / `Effect.race` / `Effect.partition`. |
| **EFF007** | No zod. Use `effect/Schema` for all envelope / structured-output validation. |
| **EFF013** | No `ts-pattern`. Use `effect/Match`. |
| **EFF022/023/028** | No `setTimeout / setInterval / node-cron`. Use `Effect.sleep`, `Effect.repeat + Schedule.spaced`, `Schedule.cron`. |
| **EFF026/032** | No `Date.now()` / `new Date()` in business code. Use `Clock.currentTimeMillis`. Persist time as `number` / ISO string. |
| **EFF027** | No `process.env` direct reads. Use `Config.string / Config.redacted` + `Layer` injection. |
| **EFF030** | No prisma / drizzle for ledger persistence. Use `@effect/sql-d1` adapter (D1) or DO SQLite directly with Schema-typed rows. |

Failure vocabulary (§7) is implemented as `Data.TaggedError` subclasses, one per
failure kind. Loop termination yields tagged errors into the ledger event stream.

### 14.2 Boundary translation

The transition layer between Effect internals and plain-TS public API is
**a single Effect.runPromise call**, scoped at the public function entry:

```ts
// internal definition (Effect-typed)
const submitAgentEffect = (spec: SubmitSpec) =>
  Effect.gen(function* () {
    const ledger    = yield* Ledger;
    const dispatcher = yield* Dispatcher;
    // ... pure Effect chain ...
    return { run_id: yield* ledger.append(...) };
  });

// public API (Promise-typed)
export const submitAgent = (spec: SubmitSpec): Promise<{ run_id: string }> =>
  Runtime.runPromise(agentOSRuntime)(submitAgentEffect(spec));
```

`agentOSRuntime` is a singleton `ManagedRuntime` created at worker startup with
all required Layers (Ledger / LLMCarrier / Quota / etc).

### 14.3 Spike code is exempt

Spike code under `spikes/**` is exempt from EFF rules. Spikes validate substrate
assumptions in throwaway form; production-grade Effect ceremony slows that down.
Implementation code under `packages/core` and `packages/*` **must** comply.

### 14.4 Future `@agent-os/effect` extension

v2 may ship `@agent-os/effect` exposing the underlying Effect-typed API directly
(skip the `runPromise` boundary). Triggered when N≥2 future users prefer Effect
over Promise. Not in v1.

---

## 15. Spike validation status

| spike | result | what it proved |
|---|---|---|
| spike-01 minimum loop | ✅ pass | env.AI.run + DO SQLite + DO RPC + reactive on() all work |
| spike-02 suspendable agent | ✅ pass | step.waitForEvent suspends; sendEvent resumes; workflow can call AI + cross-DO RPC; instance id = app-controlled scope |
| spike-03 sandbox carrier | [pending] | triggered when first agent app needs file/code execution |
| spike-04 anthropic-via-openai-compat | [pending] | medium priority — determines LLM carrier single-endpoint sufficiency |
| spike-05 Session API compaction | [pending] | triggered during Insight Helper multi-turn dialog |
| spike-06 AutoRAG per-tenant cost | [pending] | triggered when first KB use case appears |

Two spikes confirm both fundamental loop assumptions hold. Spec 24 is built on
confirmed substrate, not speculative.

---

## 16. Reference apps (skeleton `defineApp` per repo)

These are app-side code surface estimates after agent-OS adoption.

### 16.1 Insight Helper (~470 LOC, -75% from ~1500)

```ts
defineApp({ id: "insight-helper" });

on("interview.start", (event) =>
  submitAgent({
    intent: "interview user to extract EEAT insights for writing brief",
    context: {
      topic:    view.eventLast("topic.set", { scope: event.sessionId }),
      biz:      view.eventLast("settings.business_context"),
      answered: view.eventsAll("interview.answer", { scope: event.sessionId }),
    },
    agent: { provider: "anthropic", model: "claude-sonnet-4-6" },
    tools: { askUser: askUserCarrier, finalize: finalizeCarrier },
    budget: { tokens: 16_000 },
    deliver: { event: "interview.done" }, // scope = DO instance (= sessionId)
  })
);
```

### 16.2 WhatsApp quoting bot (~350 LOC for end-to-end voice+file+approval)

```ts
on("wa.message.in", (msg, env) =>
  submitAgent({
    intent: "respond to customer; parse files if attached; price if BOM detected",
    context: {
      thread: view.thread(msg.from_phone).last(15),
      kb:     view.kbRetrieve("products", msg.text),
      profile: view.customerProfile(msg.from_phone),
    },
    agent: { provider: "anthropic", model: "claude-sonnet-4-6" },
    tools: {
      parseExcel: sandboxRunCode(`${msg.from_phone}.${msg.id}`, "python"),
      parseCAD:   sandboxRunCode(`${msg.from_phone}.${msg.id}`, "python"),
      calcPrice:  withQuota(pricingCarrier, { key: msg.from_phone, window: "1day", measure: () => 1, limit: 100, refundable: false }),
      sendText:   waSendText,
      sendVoice:  ttsCarrier,
      transferToHuman: handoffCarrier,
    },
    budget: { tokens: 16_000, cost: quota(msg.from_phone, "1day", "$0.50"), time: "30s" },
    deliver: { event: "wa.agent.completed" }, // scope = DO instance (= from_phone)
  })
);
```

### 16.3 Img-Gen (~9k LOC, -53% from 19.3k)

```ts
on("image.requested", (event) =>
  submitAgent({
    intent: "generate image from prompt + conversation context",
    context: {
      conv: view.thread(event.conv_id).last(10),
      user: view.user(event.user_id),
    },
    agent: { provider: "openai", model: "gpt-image-2" },
    tools: {
      planImage:     llmCarrier,                       // [Deferred] would use withStructuredOutput when v2 ships
      generateImage: withQuota(genImageCarrier, {
        key: event.user_id, window: "∞",
        measure: (e) => e.cost_cents,
        limit: () => view.creditBalance(event.user_id),
        refundable: true,
      }),
      storeArtifact: r2PutCarrier,
    },
    budget: { tokens: 4_000, time: "5min" },
    deliver: { event: "image.delivered" }, // scope = DO instance (= conv_id)
  })
);
```

### 16.4 zeroY (WP candidate, ~14.5k LOC, -58% from 35.6k)

```ts
on("user.request_changes", (event) =>
  submitAgent({
    intent: "propose WordPress visible-text changes (no direct apply)",
    context: {
      site:    view.remote("wp-plugin", `/context?site=${event.site_id}`),
      history: view.conv_history(event.conv_id),
    },
    agent: { provider: "anthropic", model: "claude-opus-4-7" },
    tools: { createWpCandidate: wpCandidateCarrier },
    budget: { tokens: 100_000, time: "10min" },
    deliver: { event: "wp_candidate.proposed" }, // scope = DO instance (= site_id)
  })
);
```

---

## 17. Open questions ([Open])

These survived the meta-rule and need spike or N+1 evidence to resolve.

1. **[Open] view source abstraction depth.** Hyperdrive connection pool config /
   Vectorize dimension config / AE sampling all are source-specific. Thin adapters
   cover 80%; the 20% gap forces escape hatches to underlying CF APIs. Acceptable
   pragmatically; aesthetically incomplete.

2. **[Open] Service Binding cross-worker dev UX.** N≥10 workers in `wrangler dev`
   becomes coordination-heavy. Whether `@agent-os/dev` ships a helper or apps just
   accept the friction is undecided.

3. **[Open] Multi-region session migration.** AgentDO `idFromName(scope)` routes
   to a fixed region. Cross-region resume requires Durable Object Facets or
   manual migration. Out of scope v1; revisit if any app needs multi-region.

4. **[Open] Session API stability across CF SDK releases.** Currently experimental.
   We bet on API surface staying compatible through 2026. Mitigation: thin wrapping
   limits impact area.

5. **[Open] When `view.reflective.*` causes mode collapse.** Agent seeing its own
   past runs may reinforce stable but suboptimal patterns. No automated mitigation;
   doc must warn users to project last-N rather than last-1.

6. **[Open] Default Outbound Worker policy granularity.** Spec says "deny all,
   explicit allowlist". But agents that legitimately need `fetch(any URL)` (web
   research) need a per-tool allowlist mechanism. Design pending first such app.

---

## 18. Versioning and evolution

- This is v0 of the spec. Surface frozen for v1 (first reference app: Insight Helper).
- Breaking changes require new major version (`spec-25` for v2).
- Extension addition is additive (no version bump).
- New INV requires evidence of recurrence across N≥2 dogfood repos.

---

## Appendix A: Decision provenance

Each invariant traces back to:

| INV | Triggered by |
|---|---|
| INV-1 | zeroY2 + zeroy-www (ops UI rewritten N times) — refined into "infrastructure UI ok, business UI no" |
| INV-2 | All 4 repos — agent loop is the only commonly-repeated concept |
| INV-3 | img-gen credit reservation + WhatsApp rate limit + zeroY token budget all isomorphic |
| INV-4 | CF Sandbox SDK / Workflows / Agents framework all GA in 2026; rewriting them is regressive |
| INV-5 | zeroY2 hand-rolled agent runtime conflated state ownership; replayability suffered |
| INV-6 | YAGNI for v1 — third-party LLM keys add support burden, give up unified billing |
| INV-7 | CF Agents framework provides what zeroY2's `runtimeGateway.ts` (494 LOC) hand-rolled |
| INV-8 | corollary of INV-6 |
| INV-9 | zeroY2's `sandboxCf.ts` + `runtimeFiles.ts` etc. — stateful carriers are not new algebra |
| INV-10 | zeroy-www's 17-module SaaS exposed "embedded mode" trap; rejection cleaner than support |

---

## Appendix B: Spike-1 + Spike-2 raw outputs

(See `spikes/01-minimum-loop/` and `spikes/02-suspendable-agent/`. Each spike's
test.sh + README documents the validation evidence.)
