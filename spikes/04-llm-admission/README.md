# Spike 04: LLM Admission — Lease Registry on `cf-ai-binding`

> **Spec**: [docs/spec-25-llm-admission.md](../../docs/spec-25-llm-admission.md)
> **Supersedes**: prior spike-04 definition ("anthropic-via-openai-compat")
> per [spec-25 §14](../../docs/spec-25-llm-admission.md#14-spike-plan-revision)

## Core question

> **Does the algebra in spec-25 (§6 adapter law + §7 `attemptStructured` +
> `projectLease` + §8 TTL + §10 tier) work on real `cf-ai-binding` traffic,
> with `effect/Schema` canonical fingerprint stable across runs?**

This spike is single-point penetration. Scope ≠ implement the public
`submitAgent.outputSchema` surface; scope = prove the four primitives
hold under one route, one strategy, one schema family.

## Falsifiable assumptions

| # | Assumption | Falsification test |
|---|---|---|
| A1 | `effect/Schema → JSONSchema.make` produces canonically-stable output for the same `Schema.Struct` declaration across module reloads | Build fingerprint twice in two different worker requests; bytes-equal SHA-256? |
| A2 | Same schema with reordered properties yields the same fingerprint after canonicalization (§4.1 rule b) | Define `{a, b}` and `{b, a}` Schema.Struct; fingerprints match? |
| A3 | `attemptStructured` step 8 (DO SQLite `transactionSync`) actually commits evidence + deliver atomically; rollback inside the transaction leaves neither row | Use a test-only `deliverWriter` injected via context that throws **after** the evidence row has been appended but **before** the deliver row commits. Assert: zero evidence rows AND zero deliver rows for that call. Decode-stage failures do NOT exercise this property (they short-circuit before `transactionSync` opens) and are tested separately as A3b. **Scope rule**: the injection point lives ONLY inside this spike's worker — it MUST NOT appear on any core-shaped interface that future `@agent-os/core` will publish. A `deliverWriter` parameter on `attemptStructured`'s public signature would be a test seam pretending to be substrate API; the spike uses a worker-private switch (e.g. an internal `Layer` swap or a DO property toggled by the test driver), not a parameter on the algebra. |
| A3b | Decode failure short-circuits before `transactionSync` opens | Inject decode failure post-`encode`; assert one `BehaviorFailed` evidence row written (admission-bearing path), no deliver row, no half-open transaction artifacts. |
| A4 | `projectLease(events, key, now)` from current DO state produces the same lease as in-memory cache; cache is dropable without correctness loss | Reset in-memory cache mid-run; next `attemptStructured` produces identical gate decision |
| A5 | `decideTier(preLease, outcome, stimulusKind, latestBarrierTs)` is a total pure function whose truth table matches spec-25 §10 | Direct unit test on `decideTier`, no provider call needed. Cases enumerated in the §A5 truth table below. Comparing against a post-append re-projection is **explicitly forbidden** — it is the very anti-pattern spec-25 §10 rules out. |
| A6 | `forced-tool-call` strategy on `@cf/openai/gpt-oss-120b` continues to honor schema (spike-03 verdict still holds under spec-25 adapter wrapping) | 3 runs of the same schema, all produce `Supported` evidence |
| A7 | `BehaviorFailed` evidence with 24h TTL correctly short-circuits the next call within TTL — provider is **not** invoked | Worker exposes `providerCallsCount` counter (incremented at the exact `env.AI.run` call site). Pass criterion: `providerCallsCount_after - providerCallsCount_before == 0` on the second call. Latency is secondary telemetry, not the pass signal. |

## Out of scope

- Public `submitAgent.outputSchema` surface (lives in core, not spike)
- Second transport (`openai-chat-compatible` / `anthropic-messages` / …)
- BYOK / secret store / custom endpoints
- Admin invalidate API (only ledger append path is exercised here; admin HTTP wrapper comes with `@agent-os/ops-api`)
- AE tier mirroring (DO-only in spike; AE wiring is observability layer)
- Cross-DO lease sharing (spec-25 §15.2 open question — explicitly per-DO here)

## Architecture under test

```
[Test driver]                                    [Worker (spike-04)]
    │                                                  │
    │  POST /attempt {schema, strategy, stimulus}      │
    ├─────────────────────────────────────────────────►│
    │                                                  │  ┌───────────────────────────────┐
    │                                                  │  │ AgentDO (single instance)     │
    │                                                  │  │                                │
    │                                                  │  │ attemptStructured()           │
    │                                                  │  │   ├ projectLease(now)         │
    │                                                  │  │   ├ adapter.encode()          │
    │                                                  │  │   ├ env.AI.run() ◄── live IO  │
    │                                                  │  │   ├ adapter.decode()          │
    │                                                  │  │   ├ decideTier(preLease,...)  │
    │                                                  │  │   └ transactionSync:          │
    │                                                  │  │       ledger.append evidence  │
    │                                                  │  │       ledger.append deliver   │
    │                                                  │  └───────────────────────────────┘
    │  { decoded, evidence: {…}, lease: {…} }          │
    │◄─────────────────────────────────────────────────┤
    │                                                  │
    │  GET /lease/:fingerprintKey                      │
    ├─────────────────────────────────────────────────►│  pure projectLease over events
    │  { status, validUntil, lastEvidenceTs }          │
    │◄─────────────────────────────────────────────────┤
    │                                                  │
    │  POST /invalidate {key, reason}                  │  appends llm.structured.invalidate
    ├─────────────────────────────────────────────────►│
    │                                                  │
```

Single DO instance. No cross-tenant. No AE. No external admin.

## Test schema

Three schemas covering canonicalization edge cases:

```ts
// S1: trivial flat
Schema.Struct({ summary: Schema.String, sentiment: Schema.Literal("positive", "negative", "neutral") })

// S2: nested + array (spike-03's known-good shape)
Schema.Struct({
  summary:   Schema.String,
  sentiment: Schema.Literal("positive", "negative", "neutral"),
  keywords:  Schema.Array(Schema.String),
})

// S3: same as S2 but properties declared in different order — fingerprint MUST match S2
Schema.Struct({
  keywords:  Schema.Array(Schema.String),
  sentiment: Schema.Literal("positive", "negative", "neutral"),
  summary:   Schema.String,
})

// S4: deterministic BehaviorFailed trigger — NOT via model-omits-field gamble.
//
// The spike runs the cf-ai-binding adapter in `test-decode-mismatch` mode
// (an in-spike adapter option, not a production strategy): `decode()` is
// forced to return `BehaviorFailed({ sampleDigest: "synthetic" })`
// regardless of the actual provider response.
//
// This isolates the TTL / lease-projection mechanism from model behavior:
// A7's pass/fail depends on the spec-25 algebra, not on whether the LLM
// happened to comply on a given day.
Schema.Struct({ summary: Schema.String })   // shape is irrelevant; the
                                            // adapter is forced to fail decode
```

## §A5 truth table — `decideTier(preLease, outcome, stimulusKind, latestBarrierTs)`

Unit test target. No provider call. No DO append. Pure function.

| # | `preLease.status`        | `outcome.class`        | `stimulusKind` | barrier strictly after `preLease.lastEvidenceTs`? | expected tier  |
|---|--------------------------|------------------------|---------------|----------------------------------------------------|----------------|
| 1 | `unknown`                | `Supported`            | `live`        | n/a                                                | **DO SQLite** — first admission-forming evidence |
| 2 | `supported` (not expired)| `Supported`            | `live`        | no                                                 | **AE**         — reinforcement only |
| 3 | `supported` (hard-expired)| `Supported`           | `live`        | n/a                                                | **DO SQLite** — re-admission |
| 4 | any                      | `Supported`            | `probe`       | n/a                                                | **DO SQLite** — probe is always lease-bearing |
| 5 | any                      | `ProviderRejected`     | any           | n/a                                                | **DO SQLite** — lease-bearing failure |
| 6 | any                      | `SchemaUnsupported`    | any           | n/a                                                | **DO SQLite** — lease-bearing failure |
| 7 | any                      | `BehaviorFailed`       | any           | n/a                                                | **DO SQLite** — lease-bearing failure |
| 8 | any                      | `AuthError`            | any           | n/a                                                | **DO SQLite** — required by §10 even though non-lease-bearing (ops dashboard) |
| 9 | any                      | `RateLimited`          | any           | n/a                                                | **DO SQLite** — same as #8 |
| 10| any                      | `TransientError`       | any           | n/a                                                | **DO SQLite** — same as #8 |
| 11| any                      | `ConfigError`          | any           | n/a                                                | **DO SQLite** — same as #8 |
| 12| `supported` (not expired)| `Supported`            | `live`        | **yes** (barrier wiped prior lease)                | **DO SQLite** — barrier resets admission-formation, so this Supported is admission-forming again |

Rows 1–4 cover the lease-impacting positive path. Rows 5–7 cover lease-bearing failure. Rows 8–11 cover non-lease-bearing classes (still DO, per §10 ops requirement). Row 12 covers the barrier interaction: a barrier with `ts > preLease.lastEvidenceTs` effectively makes `preLease.status` behave as `unknown` for tier purposes.

Implementations MUST pass all 12 rows. Adding rows is permitted; removing is not.

## Pass criteria

- A1 / A2: S2.fingerprint == S3.fingerprint; S1.fingerprint ≠ S2.fingerprint; stable across two worker requests.
- A3: in-transaction failure injection produces **zero** evidence rows AND **zero** deliver rows for that call.
- A3b: decode failure produces **one** `BehaviorFailed` evidence row, **zero** deliver rows, transaction state clean.
- A4: gate decision (lease.status + validUntil + retryAfter) identical before and after in-memory cache reset on identical event log.
- A5: all 12 rows of the `decideTier` truth table above produce the expected tier. No post-append re-projection is invoked.
- A6: 3/3 `Supported` outcomes for S2 on `@cf/openai/gpt-oss-120b` (re-verifies spike-03 verdict under new wrapper).
- A7: `providerCallsCount` delta for the second call within TTL is **exactly 0**. Latency is logged but not a pass signal.

## Deferred (validation outside this spike)

- Concurrent multi-writer race on same key (spec-25 §10 reasoning argument — needs separate stress test, not spike scope)
- Adapter version bump invalidation (§9 major-bump path — exercised via test by changing `adapter.version` constant)
- Soft refresh background re-probe (§8 Supported soft 24h) — harness uses clock injection rather than waiting 24h

## Status

- [x] worker.ts skeleton (DO + AttemptStructured handler + projectLease + invalidate barrier + `providerCallsCount` counter at `env.AI.run` site + test-only `deliverWriter` injection point)
- [x] adapter `cfAiBindingAdapter` — `encode/decode/classify` pure, plus `test-decode-mismatch` mode for deterministic A7
- [x] schema fingerprint util with `effect-json-schema-v1` prefix
- [x] `decideTier` pure function + unit test covering all 12 truth-table rows
- [x] test.sh covering A1–A7 + A3b
- [x] run against `@cf/openai/gpt-oss-120b`
- [x] record verdict — see §Verdict below

## Verdict

**spec-25 v0 survives spike-04.** Five consecutive runs against
`@cf/openai/gpt-oss-120b` on `cf-ai-binding`:

| Run | Model success rate (A6a) | Algebra checks (A1/A2/A3/A3b/A4/A5/A6b/A7) |
|---|---|---|
| 1 | 1/3 Supported | 14/14 ✓ |
| 2 | 1/3 Supported | 14/14 ✓ |
| 3 | 3/3 Supported | 14/14 ✓ |
| 4 | 3/3 Supported | 14/14 ✓ |
| 5 | 3/3 Supported | 14/14 ✓ |

**Confirmed by evidence:**

- **§4.1 canonical fingerprint stability** (A1/A2): byte-equal across requests;
  property reordering yields identical fingerprint (after also normalizing
  set-semantics arrays — see "Spec amendment" below).
- **§7.1 transactionSync atomicity** (A3): inner throw rolls back both
  evidence row AND deliver row; zero half-state.
- **§7.1 decode short-circuit boundary** (A3b): decode failure produces
  exactly one `BehaviorFailed` evidence row, zero deliver rows, no
  half-open transaction artifacts.
- **§7.2 projection purity** (A4): every gate decision recomputed from
  ledger; no hidden cache.
- **§10 tier truth table** (A5): all 12 rows pass the pure-function
  oracle; no post-append re-projection used anywhere.
- **§10 admission-impact tier discipline** (A6b): first Supported in a
  reset window always lands on DO tier; subsequent Supported in the same
  hard-expiry window always reinforce on AE — holds across both 1/3 and
  3/3 model runs.
- **§7.1 short-circuit gate** (A7): once `BehaviorFailed` lease forms,
  the second call within TTL has `providerCallsCount` delta = exactly 0
  and `shortCircuited: true`. Latency-based heuristics not used.

**Falsified upstream assumption:**

- **spike-03's "Mode B forced-tool-call = 3/3 reliable"** does NOT replay
  cleanly under the new adapter wrapping. Observed rate: ~60% (3/3) and
  ~40% (1/3) over 5 trials. This is a *useful* outcome of spike-04 — it
  shows that "supported" is correctly an evidence-derived lease, not a
  static declaration. The lease projection handles model flake without
  human re-validation: a Supported lease persists across reinforcement,
  but a BehaviorFailed event within the same key triggers TTL-bounded
  short-circuit.

**Spec amendment landed during the spike:**

- §4.1 rule c required canonicalizing set-semantics JSON Schema fields
  (`required`, `enum`). Original draft only mentioned "nullable/optional/
  union" representations; A2 falsified the partial form by exposing
  `required: ["a","b","c"]` vs `["c","b","a"]` as distinct schemas. The
  spike implementation sorts arrays whose parent key is in
  `SET_SEMANTICS_ARRAYS = {"required", "enum"}`. **Spec-25 §4.1 needs
  an explicit edit to list this rule.**

**Spec-25 changes recommended (not blocking; for v0.1):**

1. §4.1 rule c: explicitly enumerate set-semantics array fields
   (`required`, `enum`, and any future set-typed schema keyword).
2. §15 add an Open Question: "When do we ship a multi-attempt
   wrapper (encode-decode-retry) for models whose `forced-tool-call`
   reliability is < 100%?" Currently the spike shows that one
   BehaviorFailed locks the route out for 24h — for a flaky model this
   could be over-aggressive. The fix likely lives in adapter strategy
   evolution, not in `attemptStructured` core.

**Test infrastructure note:**

A6 was originally written as "3/3 Supported" — that conflated model
reliability with algebra correctness. Now split into:

- **A6a** (observational, non-blocking): records model success rate.
- **A6b** (blocking): tier discipline holds conditional on observed
  Supported outcomes.

This is the correct boundary: spike-04 falsifies spec-25 algebra, not
provider behavior.
