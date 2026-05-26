# Spec 24 Addendum: Symphony Comparison & Adopted Decisions

> **Status**: Decision record (frozen 2026-05-25)
> **Relates to**: [spec-24-invariants-and-surface.md](./spec-24-invariants-and-surface.md)
> **Source compared**: [openai/symphony SPEC.md](https://raw.githubusercontent.com/openai/symphony/main/SPEC.md)

---

## 0. Why this document exists

Symphony (OpenAI, 2026) is the most visible public spec describing how to run
autonomous coding agents at scale. Reading it surfaces the question:

> Which Symphony ideas belong in agentOS, and which would push agentOS from
> "CF substrate" into "daemon product"?

This doc records the decision. **Symphony is borrowed algebraically, rejected
as a product shape.**

---

## 1. Invariant adopted

**Scheduler state, execution state, and business facts must be layered, and
each layer has exactly one writer.**

Symphony states this as: orchestrator is scheduler/reader, agent is the only
ticket writer; running/claimed/retry sets are orchestrator-exclusive; restart
recovery is tracker- + filesystem-driven, never reconstructed from in-memory.

agentOS INV-5 and §3 (ledger / derived / external) is the same invariant.

---

## 2. agentOS is already stronger than Symphony on state ownership

Symphony persists nothing on restart and rebuilds from external sources.
agentOS uses DO SQLite as a free transactional store, but the SSoT discipline
is sharper:

| Concept | agentOS placement | SSoT? |
|---|---|---|
| `events` table | ledger | **yes** |
| `scheduled_events` table | pending intent buffer | no — fires into `events`, references via `fired_event_id` |
| Quota counters | projection over `events` where `kind='dispatch.consumed'` | no |
| `view.reflective.*` | pure projection | no |
| Carrier state (sandbox/workspace/browser) | lives in the carrier, addressed by scope id (INV-9) | no |

This is not "to be added" — it is observable in
[packages/core/src/quota.ts](../packages/core/src/quota.ts) and
[packages/core/src/scheduler.ts](../packages/core/src/scheduler.ts).
The fix is **spec-level**: make the fact explicit so future contributors
cannot accidentally introduce a second writer.

---

## 3. Mistakes corrected during this review

Two judgments produced during the Symphony comparison were withdrawn:

| Withdrawn | Reason |
|---|---|
| Name the per-carrier-call entity `DispatchAttempt` | `dispatch` is an effect, not an attempt. `attempt` is a field of `ToolCall`, not its abstract name. |
| Introduce `agentos.config.ts` for declarative agent module config | Violates INV-4. `submitAgent` is already the declarative surface; deployment declaration is owned by `wrangler.jsonc`. A second policy file is duplicate state ownership. |

Also rejected mid-review: a generic `withStall` middleware. Stall detection
is a daemon concern; CF Workflows `step.do` timeout + `budget.time` already
cover it at the substrate layer. Symphony's `stall_timeout_ms` exists because
Elixir has no equivalent runtime guarantee.

---

## 4. Lifecycle vocabulary mapping

Symphony's three-level lifecycle (RunAttempt / LiveSession / Turn) does not
map 1:1 because INV-7 (CF Agents framework + Session API) eliminates
`LiveSession`. agentOS uses four terms:

| Term | Definition | Symphony analogue |
|---|---|---|
| `AgentRun` | One `submitAgent` invocation; spans 1..N `LlmTurn` until budget/retries exhaust or LLM stops emitting tool calls | RunAttempt |
| `LlmTurn` | One provider call; emits 0..N `ToolCall` | Turn |
| `ToolCall` | One carrier dispatch within an `LlmTurn`; carries `attempt: number` field for retries | (none — Symphony has no parallel tool calls in spec) |
| `Continuation` | Subsequent input on same `AgentRun` after suspend/resume (spike-2: `step.waitForEvent`) | continuation turn on same `thread_id` |

`LiveSession` is intentionally absent: there is no long-lived agent
subprocess in CF Workers. Session API handles cross-turn state
(history compaction, hibernation) without exposing a process lifetime.

---

## 5. PR plan

Four spec edits. **All four landed** (v0.2.9 hygiene chain).

| PR | Status | Scope | Landed in |
|---|---|---|---|
| **PR0** | ✅ done | Add SSoT discipline to §3: `events` is the sole ledger truth; `scheduled_events` is pending intent buffer; quota counters are projection (not stored); `view.reflective.*` is projection. | [spec-24 §3.1](./spec-24-invariants-and-surface.md#31-ssot-discipline-derived-from-symphony-comparison) |
| **PR1** | ✅ done | Add `AgentRun / LlmTurn / ToolCall / Continuation` lifecycle vocabulary. Document `LiveSession` absent by construction (CF Workers has no long-running process; INV-7 Session API handles cross-turn state without exposing process lifetime). | [spec-24 §5.1.1](./spec-24-invariants-and-surface.md#511-lifecycle-vocabulary) |
| **PR2** | ✅ done | Mark §6.2 `withStructuredOutput` as **deferred from v1 MVP**. Spike-03 falsified `response_format: json_schema` (Workers AI JSON Mode is best-effort, not contractual). The synthetic-tool + forced-`tool_choice` design was prototyped in v0.2.9 and reverted because no current reference app needs typed LLM output — see [structured-output-exploration.md](../notes/structured-output-exploration.md). Resume condition: first app surfaces real need, OR CF ships strict-schema model. | [spec-24 §6.2](./spec-24-invariants-and-surface.md#62-withstructuredoutputcarrier-schema--deferred-from-v1-mvp) |
| **PR3** | ✅ done | Stateful carrier safety constraints C1–C4: declare state root keyed by scope; validate path containment; publish cleanup primitive; do not expose carrier-internal shape to shared logic. Conditions on carrier implementations, not on §5 core algebra. | [spec-24 §11.1](./spec-24-invariants-and-surface.md#111-stateful-carrier-safety-constraints) |

---

## 6. Explicit non-goals

We deliberately do **not** adopt the following from Symphony:

| Rejected | Why |
|---|---|
| `WORKFLOW.md` hot-reload + last-known-good fallback | Daemon operational semantics. agentOS is a library substrate; deploy-time validation + fast-fail is the correct stance. |
| Daemon scheduler with poll-loop / reconciliation tick | agentOS dispatches reactively via `on()` and `scheduleEvent`. A long-running tick conflicts with Workers request lifetime. |
| `withStall` middleware in core | Subsumed by `budget.time` + CF Workflows `step.do` timeout. |
| `agentos.config.ts` declarative module file | Duplicates the role of `wrangler.jsonc` + `submitAgent` declaration. Violates INV-4. |
| `CONFORMANCE.md` test matrix | No N≥2 implementations exist; nothing to conform against. Revisit if a second runtime appears. |
| Issue-tracker integration (Linear or otherwise) in core | Tracker is an `ingest` channel and a carrier, not a core concept. Apps wire their own. |

---

## 7. Boundary summary

> **Borrow from Symphony**: the state-ownership discipline and the
> Run/Turn/ToolCall/Continuation lifecycle vocabulary.
>
> **Reject from Symphony**: the daemon product shape — hot-reload config,
> reconciliation tick, stall-detection middleware, tracker-coupled scheduler.
>
> agentOS remains a Cloudflare substrate. It does not grow into a
> coding-agent runner product.

---

## Appendix A: Evidence references

- Symphony state ownership: SPEC.md §"Orchestration State Machine" and
  §"Partial State Recovery (Restart)" — `https://raw.githubusercontent.com/openai/symphony/main/SPEC.md`
- agentOS quota-as-projection: [packages/core/src/quota.ts](../../packages/core/src/quota.ts)
- agentOS scheduled-intent-buffer: [packages/core/src/scheduler.ts](../../packages/core/src/scheduler.ts)
- structured-output exploration note: [structured-output-exploration.md](../notes/structured-output-exploration.md)
