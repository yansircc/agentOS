# a91: Independent Subagent Architecture Review

## Summary

stable axis: agentOS project invariants, ledger facts, schema source ownership,
runtime ownership, provider boundaries, and product/substrate boundaries.  
change axis: reviewer perspective and evidence-gathering path.  
invariant: implementation claims are not complete until an independent scan tries
to find invariant violations outside the declared task scope.

This task runs after a78-a94 are implemented and verified. It is read-only unless
the reviewer opens a follow-up task for a concrete fix.

## Review Setup

- Spawn all available review subagents as `gpt-5.5` with `xhigh` reasoning.
- Each subagent receives the same checklist below.
- Each subagent must inspect the current repository state, not only the task
  plan.
- Split focus areas to reduce duplicate work:
  - ledger / durable process / Cloudflare DO;
  - runtime / admission / submit / budget / Effect AI;
  - schema / public API / docs generation / distribution;
  - carriers / workspace / execution domains / provider material;
  - product proof / AG-UI / React/Svelte bindings / web-cursor consumption;
  - durable process algebra / wait-resume / process projection rebuild;
  - provider output item ADT / provider adapter boundaries;
  - trace context / OTLP projection / eval-substrate deferral.
- The coordinator merges findings by failure class, not by file list.
- If a finding only proves one local instance, the report must name the larger
  class and the structural fix or the explicit reason that class-level removal
  is not viable now.

## Required Output

Each subagent returns:

```text
stable axis:
change axis:
invariant:
failure:
minimal fix:
verification:
remaining risk:
```

The coordinator returns one merged report with:

- Top 3 architecture risks;
- Top 3 unnecessary complexity sources;
- most dangerous illusion;
- boundary most worth redrawing;
- code most worth deleting or merging;
- design most worth preserving;
- one smallest high-leverage refactor;
- one verification method proving the refactor lowers risk.

## Code Review Checklist

P0 = must inspect; P1 = architecture-level; P2 = design-level; P3 = quality-level.

### P0: Core Architecture And Invariants

- [ ] **[P0] SSOT: one fact exists in one place**. Is there duplicated state? Is
      derived data such as cache, view model, URL params, or projections treated as
      source of truth?
- [ ] **[P0] Invariants have explicit landing points**. Are always-true rules
      enforced by types, schemas, database constraints, state machines, or boot
      validation, rather than developer memory?
- [ ] **[P0] Impossible states are hard to construct**. Do data structures allow
      illegal states such as `isPaid=true` with `paidAt=null`, or arbitrary strings
      outside a status vocabulary?
- [ ] **[P0] Hidden state machines are explicit**. Are entity states and legal
      transitions centrally defined? Are illegal transitions blocked?
- [ ] **[P0] Boundary data and errors have a failure model**. Are network
      failure, timeout, concurrency conflict, and partial failure defined? Are errors
      propagated explicitly rather than swallowed?
- [ ] **[P0] Authorization holds server-side**. Frontend hiding is not
      authorization. Are critical operations checked at the server/backend boundary?

### P1: Data Flow, State, And Effects

- [ ] **[P1] Data flow is traceable**. Can readers track where data comes from,
      where it goes, and which transformations occur? Are there bypass reads from
      globals, localStorage, URL state, or caches?
- [ ] **[P1] No implicit two-way dependency**. Does A write B while B writes A?
      Are read and write paths mixed?
- [ ] **[P1] Effects are isolated and explicit**. Are requests, database writes,
      messages, and global mutations centralized? Are there hidden writes in render,
      getters, selectors, or validators?
- [ ] **[P1] Pure logic and effects are separate**. Can business decisions be
      tested without network, database, time, or randomness?
- [ ] **[P1] Async flows are stable**. Are race conditions, stale closures,
      duplicate submits, and out-of-order responses structurally handled? Can retry
      double-create or double-charge?
- [ ] **[P1] Idempotency is clear**. Which operations can repeat? Which cannot?
      Is eventual consistency presented honestly rather than pretending to be
      synchronous consistency?
- [ ] **[P1] Persistence boundaries are clear**. What belongs in durable storage,
      what is temporary UI state, and what is derived?

### P1: Boundaries And Modules

- [ ] **[P1] Module boundaries are clear**. Does each module have an explicit
      responsibility and non-responsibility? Do dependencies point from high-level
      logic to stable abstractions rather than implementation details?
- [ ] **[P1] UI does not contain business rules**. Are page/component/form rules
      actually domain/service/schema rules?
- [ ] **[P1] Infrastructure does not pollute domain logic**. Do database, HTTP,
      third-party SDK, or environment details leak into core logic?
- [ ] **[P1] Third-party services are wrapped**. Are Stripe, Supabase, OpenAI,
      Effect AI, AG-UI, and provider SDKs isolated behind agentOS-owned boundaries?
- [ ] **[P1] Interfaces hide implementation details**. Do callers depend on
      capability rather than internal structure, fields, lifecycle, or execution
      order?

### P2: Complexity And Abstraction

- [ ] **[P2] Complexity has business reason**. Is complexity caused by real
      domain complexity, or by implementation choices? Are there premature
      frameworks, adapters, or generics?
- [ ] **[P2] DRY does not merge accidental similarity**. Only repeated
      expression of the same fact should merge. Similar code with different change
      reasons should stay separate.
- [ ] **[P2] Abstractions do not create reverse dependencies**. Does reuse force
      callers to know more context? Did code shrink while understanding cost grew?
- [ ] **[P2] No leaky abstraction**. Must callers know internal behavior to use
      a simple API correctly?
- [ ] **[P2] One function stays at one abstraction level**. Does a function mix
      business intent with low-level implementation details?
- [ ] **[P2] Complexity has deletion conditions**. Do temporary compatibility,
      migration logic, feature flags, or defensive branches have explicit removal
      conditions?

### P2: Readability And Naming

- [ ] **[P2] Names describe real behavior**. Does a name say what the code does
      and does not do? Does `getX` actually fetch, cache, normalize, or mutate?
- [ ] **[P2] Side effects are visible from names**. Do write, mutate, send,
      delete, and sync functions say so?
- [ ] **[P2] Abstraction names are not empty**. Do `manager`, `handler`,
      `helper`, `utils`, or `service` hide the real responsibility?
- [ ] **[P2] Business language is unified**. Is one concept called by multiple
      names?
- [ ] **[P2] Least surprise holds**. Does behavior match reader expectation and
      local convention?
- [ ] **[P2] Cognitive context is flat**. How many external facts and jumps are
      needed to understand a path? Is control flow visible?

### P2: Data Structure Semantics

- [ ] **[P2] Data structures fit the domain**. Is the shape a natural domain
      expression, or a temporary UI assembly?
- [ ] **[P2] No boolean soup**. Do many `isX`, `hasX`, or `shouldX` flags encode
      a hidden state machine that should be a status union?
- [ ] **[P2] Nullable values have explicit semantics**. Are `null`,
      `undefined`, empty string, and empty array distinct and consistent?
- [ ] **[P2] Input, domain object, output, and database record are separate**.
      Are form input, domain model, database row, and API response collapsed into one
      type?
- [ ] **[P2] One object does not carry multiple lifecycles**. Does the same
      object represent draft, submitted, completed, and terminal states?

### P3: Change, Extension, And Deletion

- [ ] **[P3] Change points are isolated**. Are stable and volatile parts
      separate? How many places change for one new field, state, channel, or payment
      method?
- [ ] **[P3] No shotgun surgery**. Does a small change touch many unrelated
      files? Is the modification path predictable?
- [ ] **[P3] Implementations are replaceable**. Can database, API, UI library,
      provider, or adapter changes stay inside boundaries?
- [ ] **[P3] Features can be safely removed**. Are entrypoints, state, data,
      tasks, permissions, and tests discoverable? Are cron, webhook, and listener
      dependencies visible?
- [ ] **[P3] Code can decrease**. Is the repo in patch-only mode? Do deprecated
      or legacy paths have deletion plans?

### P3: Robustness And Security

- [ ] **[P3] Empty and boundary values are handled consistently**. Is validation
      done at system entry?
- [ ] **[P3] APIs are hard to misuse**. Is correct usage natural? Are dangerous
      operations explicit and structurally guarded?
- [ ] **[P3] Defaults are safe**. Are defaults conservative and recoverable? Are
      configuration and code separated?
- [ ] **[P3] Data scale changes are acceptable**. What happens when 10 records
      become 100,000? Are pagination, query, rendering, and cache behavior clear?
- [ ] **[P3] Observability is sufficient**. Can key state changes be traced? Do
      errors include request id, user id, entity id, and operation where relevant?

### P3: Testing And Verification

- [ ] **[P3] Core logic is easy to unit-test**. If network, UI, database, time,
      or randomness is required to test main rules, treat it as a design smell.
- [ ] **[P3] Tests verify behavior rather than implementation**. Does internal
      refactoring avoid unrelated test failures? Do tests duplicate implementation
      logic?
- [ ] **[P3] Critical invariants are tested**. Are always-true rules, failure
      paths, timeouts, and invalid inputs covered?
- [ ] **[P3] Test data expresses business meaning**. Avoid opaque `foo`, `bar`,
      and `test123` when domain names would clarify the rule.

## Gates

The review is complete only when the merged report exists and every P0 finding
is classified as one of:

- structurally impossible after the current refactor;
- confirmed defect with a proposed class-level fix task;
- intentionally accepted risk with explicit failure model and removal condition.

Run at least:

```sh
bun run check
bun run typecheck
bun run test
effect-skill-scan <worktree> --strict --json --profile
git diff --check
```

If any finding touches runtime harness code, Durable Object behavior, storage,
Wrangler config, runtime facades, or provider adapters, also run:

```sh
bun run check:runtime
```

Before treating the review as release-blocking complete, run:

```sh
bun run check:full
```
