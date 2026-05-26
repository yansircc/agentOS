# Spec 30: substrate boundary cookbook (charter)

> **Status**: Charter draft (drafted 2026-05-26)
> **Type**: Meta-spec — defines what `docs/cookbooks/` IS, not what core code does
> **Depends on**: [spec-24 §11 carriers](./spec-24-invariants-and-surface.md), [spec-26 §4 falsification rule](./spec-26-img-gen-substrate-survey.md), [spec-28 dispatch/resources/image](./spec-28-img-gen-gap-implementation-plan.md), [spec-29 ledger event stream](./spec-29-ledger-event-stream.md)
> **Does not deliver**: any new core primitive. Adding a primitive requires its own spec.
> **App pressure**: zeroY (saga + WP carrier rollback), vibe-coding-web (carrier mutation + large artifact)

---

## 0. Purpose

Define the **boundary etiquette** for crossing from agentOS's closed
algebra (ledger + on/submit/emit/schedule/dispatch/stream) into things
that algebra cannot internalize: time, humans, external processes,
large artifacts, multi-step compensation. The cookbook is where
apps learn to use existing primitives in disciplined patterns,
without inflating the core invariant set.

Post-spec-28/29, two scans (VCW, zeroY) confirmed zero new substrate
primitives are needed for either application class. What they DID
reveal is that apps will get the boundary wrong if there is no
documented pattern — and that wrongness leaks back into the substrate
as duplicate SSoT, lost partial state, or oversized ledger payloads.

This charter:
1. Names what counts as a cookbook entry vs. a core primitive.
2. Lists confirmed cookbook entries grounded in app pressure.
3. Sets the graduation rule: when does a cookbook pattern become a
   core primitive (`@agent-os/patterns` package or new core spec).
4. Documents the format / location convention for cookbook files.

The actual recipes live in `docs/cookbooks/*.md`; this spec only
defines what's in scope and what triggers escalation.

---

## 1. Invariant — what the cookbook IS and IS NOT

> **Cookbook entries document discipline for crossing the algebra ↔
> non-algebra boundary using existing primitives. They never introduce
> new primitives, never modify invariants, never become required
> reading to use core.**

Corollaries:

- **C-1.** A cookbook entry MUST be expressible today, using only
  `AgentDOBase` public surface + spec-28/29 primitives. If a recipe
  requires a primitive that doesn't exist, that's a spec proposal,
  not a cookbook entry.
- **C-2.** A cookbook entry MUST cite ≥1 app showing the forge. No
  speculative recipes ("apps might want to..."). spec-26 §4 falsification
  rule applies one level up: the recipe exists because an app already
  hand-rolled the pattern incorrectly or verbosely.
- **C-3.** A cookbook entry is optional reading. Apps that solve the
  same problem differently are not wrong. The cookbook is the
  recommended discipline, not a contract.
- **C-4.** When the same pattern appears in **two independent app
  domains** (different generator class, not two instances of the same
  app), the pattern graduates per §4 — either to a helper package or
  to a core spec. Until N=2, it stays cookbook.

What this rules out:

- Cookbook entries that ARE substrate primitives in disguise (e.g.,
  "how to implement durable workflow on top of ledger"). Those are
  either spec proposals or rejected primitives.
- Cookbook entries that contradict invariants (e.g., "how to write
  capability evidence outside `attemptStructured`" — direct
  violation of spec-25 §2 SSoT placement).
- Cookbook entries copied from app source verbatim. Recipes are
  generalized patterns; if it only applies to one app, it's docs in
  that app's repo, not the cookbook.

---

## 2. Confirmed entries

These are slated for write under this charter, with pressure evidence
from the post-spec-28/29 app scans. Each entry is a separate file in
`docs/cookbooks/`; this section is the index.

### 2.1 `approval-race.md` — wait for external decision OR timeout

**Generator**: agent's control flow leaves itself; resumes when fact F
arrives by its kind/predicate, OR when time T elapses, whichever first.

**App pressure**: zeroY `packages/workflows/src/cloudflare-runner.ts:308`
uses Cloudflare Workflows' `stepApi.waitForEvent("zeroy.approval_decision",
timeout: "24 hours")`. Same shape would appear in any human-in-the-loop
agent flow.

**Pattern (using existing primitives)**:

```ts
// at handoff point in a tool or submit handler:
await this.emitEvent({
  event: "approval.requested",
  data: { runId, summary },
});
await this.scheduleEvent({
  event: "approval.timeout",
  data: { runId },
  at: Date.now() + 24 * 60 * 60 * 1000,
});

// elsewhere (or in DO constructor):
this.on("approval.decided", async (e) => {
  // human path; cancel the pending timeout via barrier or just check
  // ledger for which event arrived first
  await this.runNextStep(e.payload);
});

this.on("approval.timeout", async (e) => {
  // timeout path; check ledger to see if approval already came in
  // (id ordering decides winner)
  await this.runTimeoutStep(e.payload);
});
```

**Winner is `id ASC` minimum** between the two events with matching
`runId`. The cookbook entry will spell this out with a working
`events()` projection example.

**Why cookbook not primitive**: same three resume-paths
(scheduleEvent / emitEvent / dispatchToScope inbound) are projections
of the same fact-arrival operator. Wrapping them in a `waitForFact(...)`
helper is ergonomic, not algebraic. If a second app shows the same
verbosity pain, lift to `@agent-os/patterns` package.

---

### 2.2 `carrier-mutation.md` — round-trip state changes through non-ledger carriers

**Generator**: tool touches an external state root (filesystem, WP
plugin, R2, external API). The mutation can succeed, fail, or
partially succeed. The ledger needs proof of what happened without
swallowing the whole carrier state.

**App pressure**: zeroY
`apps/wp-plugin/includes/command-loop-apply.php:27` applies WP page
changes; `:645` rolls back. VCW's tool outputs (file edits, shell
commands, deploy logs) can run to megabytes. Both forge their own
artifact/ref discipline.

**Pattern**:

```ts
// inside a tool's execute(args):
const result = await carrier.applyChange(args);
// result may include: applied bytes, rollback evidence, partial-failure
// metadata. NOT all of it goes into the ledger payload.

return {
  artifactRef: result.artifactRef,           // app-owned key (R2 / FS path / WP-CLI handle)
  rollbackEvidence: result.rollbackToken,    // small token, not bytes
  status: result.partialFailure ? "partial" : "ok",
  // NEVER: full bytes of changed files, full WP page HTML, full shell output
};
```

The tool's return becomes `tool.executed.payload` — keep it small. Big
payloads live in the carrier; the ledger holds the reference. Apps that
need rollback later read `rollbackEvidence` from the ledger event,
apply via carrier's rollback API. The ledger writes
`tool.rollback_executed` with the same evidence reference.

**Why cookbook not primitive**: INV-9 already says carriers are
app-owned. The substrate cannot abstract over all carrier shapes
(filesystem ≠ WP plugin ≠ R2 ≠ external API). What it CAN do is
document the discipline: ref-not-bytes, rollback-evidence-on-the-ledger.

If two app domains forge the same carrier wrapper (e.g., both build
their own "R2 artifact registry"), graduate to a helper. Today both
zeroY and VCW have R2 / FS artifact patterns but with different keys
and different lifecycle policies — they don't share a carrier
generator.

---

## 3. Watchlist — patterns under observation, NOT slated for write

These have appeared in **one** app's pressure evidence. Cookbook write
is deferred until a second independent app shows the same shape.

| Pattern | Origin | Graduation trigger |
|---|---|---|
| `saga-as-data` — pipeline + compensation declared as static catalog | zeroY `packages/workflows/src/index.ts:167` step + `:243` compensation plan | second app needs static pipeline catalog (img-gen multi-step? vibe deploy pipeline?). If triggered, decide: cookbook recipe OR `@agent-os/patterns` package OR new core spec (depends on whether the catalog is just app data or needs substrate-enforced sequencing) |
| `multi-tenant collaboration` — multiple users mutate the same agent state | none observed yet | a third app where one DO scope is shared by multiple identities (e.g., team-edit-same-doc). Today scope is per-user-per-session; shared scope = different scope-naming algebra. Could break or stretch INV-9 |
| `cross-scope fan-in` — admin dashboard watches N DO scopes | none observed yet | second app needs to multiplex `streamEvents` across many DOs. Today: open N EventSource connections from client. Substrate-side fan-in primitive only if N grows past O(10) per client |
| `view materialization across many scopes` — query like "all sessions for user X" | none observed yet | scope-per-session means cross-scope SQL is impossible inside one DO. Apps using D1 for index today (see spec-26 §4 C4-style carrier). If second app forges same index pattern, document as carrier index recipe |
| `typed turn failure projection via classify` | spec-27 §11 OQ 6 | a callLlm caller needs `FailureClass`-aware retry. Today callLlm passes raw `UpstreamFailure`. Confirmed gap from one or more app needing adaptive turn retry |

The watchlist is itself a cookbook discipline: write nothing without
N≥2. Adding entries here is cheap; promoting them is the gate.

---

## 4. Graduation criteria

A cookbook entry graduates from `docs/cookbooks/*.md` to one of three
higher tiers when triggered:

### 4.1 Tier 1 → Tier 2: `@agent-os/patterns` helper package

Trigger: same pattern appears in **2 independent app domains**, AND
the existing primitives are syntactically heavy enough that apps will
copy-paste-modify the recipe and drift over time.

Action: extract the pattern into a small helper package
(`@agent-os/patterns` or named per pattern). No core changes. Helper
package is opt-in; apps that don't use it are not wrong.

Example future trigger: if both zeroY and VCW eventually need the
`approval-race` pattern, a helper like:
```ts
import { waitForFactOrTimeout } from "@agent-os/patterns";
await waitForFactOrTimeout(this, { event: "approval.decided", timeoutMs: 24h });
```

### 4.2 Tier 1 → Tier 3: new core spec / primitive

Trigger: pattern requires a primitive that **cannot be expressed
correctly** with existing surface, even with a helper. The substrate
itself needs new shape.

Action: write a spec proposal in `docs/specs/`. Goes through the same
review cycle as spec-28/29.

Bar for this is intentionally high. Most patterns can be expressed;
the cookbook entry is the proof. A spec is justified only when
"correctly" cannot be achieved without core change (e.g., needs new
transaction boundary, needs ledger schema extension, needs adapter
interface widening).

### 4.3 Tier 1 → demoted: pattern was wrong

Trigger: the cookbook entry causes app-side bugs more often than it
prevents them.

Action: revise the recipe OR mark it deprecated with a note explaining
what should be done instead. Cookbook entries are revisable; their
authority is documentation, not contract.

---

## 5. Format conventions

Each cookbook entry follows:

```
# <pattern-name>

> **Pattern**: <one-line summary>
> **Pressure evidence**: <app file:line + commit ref>
> **Uses**: <list of agentOS primitives required>
> **Does NOT introduce**: <re-state: no new primitive>

## Generator
<what algebra-↔-non-algebra boundary this crosses>

## Pattern code
<small, working snippet using only existing surface>

## Invariants the pattern preserves
<list of which spec-24/25/etc invariants this respects>

## Common mistakes
<things apps will get wrong if they skip the recipe>

## Graduation watchlist
<what would trigger this to Tier 2 or Tier 3>
```

The "Generator" + "Invariants preserved" sections are load-bearing —
they make the recipe re-derivable, not just copy-pastable.

---

## 6. Sequencing vs spec-28/29 implementation

Cookbook write is NOT on the spec-28/29 implementation critical path.
Order:

1. **spec-28 P1 implementation** (in progress: `core/src/dispatch.ts`,
   ledger schema additions, contract tests). Includes `traceContext`
   envelope from §2.5. — **blocks nothing in spec-30**.
2. **spec-28 P2 implementation** (Resources). — blocks nothing.
3. **spec-29 implementation** (events / streamEvents with race-free
   tail algorithm per §3 canonical form). — blocks nothing in
   spec-30 directly, but the `approval-race` cookbook entry will be
   easier to write once apps can actually observe the race resolution
   live.
4. **spec-30 cookbook §2.1 `approval-race`** — write after spec-29
   lands (so the cookbook can show working streamEvents-based
   observability of the winner).
5. **spec-30 cookbook §2.2 `carrier-mutation`** — write after spec-28
   P3 (image route) lands, since the image adapter is itself an
   example of carrier-style state external to the ledger (image
   bytes in R2, refs in evidence).
6. **spec-28 P3 implementation** (image route + `generateImage`).
7. **spec-28 P4** (R2 docs note — already merged).
8. **spec-31** (image admission, if triggered by 3+ BehaviorFailed
   per spec-28 §4.2 trigger condition). Not scheduled.

Watchlist items in §3 require no work today. Re-evaluate when N=2
trigger fires per item.

---

## 7. Open questions

1. **Does `@agent-os/patterns` exist before any entry graduates?**
   Two options: (a) lazy — create the package only when the first
   helper graduates; (b) eager — create empty scaffold now so the
   import path is known. Lean toward (a): empty packages rot.

2. **Cookbook authorship — substrate maintainer vs app authors?**
   Confirmed entries (§2) are substrate maintainer's responsibility
   since they document discipline that protects substrate invariants.
   App-specific recipes (e.g., "how zeroY uses
   AgentDOBase.dispatchToScope") would live in the app's own repo,
   not here.

3. **Versioning cookbook entries.** Recipes will change as substrate
   evolves. Each entry should carry a `> **Tested against**: agentOS
   v0.2.X` header so apps know which substrate version the snippet
   was validated against. Drift is detected by `bun test` against
   new core releases? Or manual audit per release? — defer until
   cookbook has ≥2 entries to validate against.

4. **Cross-reference policy.** Cookbook entries reference specs
   freely (link to spec-24 §11, spec-25 §7.2, etc). Specs do NOT
   reference cookbook entries (they're optional reading). One-way
   dependency keeps spec churn from rippling into cookbook every
   release.

---

## 8. Decision provenance

| Decision | Origin |
|---|---|
| Cookbook is meta, not new core primitives | post-28/29 scans of VCW and zeroY both returned "0 confirmed core gaps". Pressure evidence is for boundary discipline, not algebra extension |
| N=2 independent apps before graduation | spec-26 §4 falsification rule applied one level up |
| Two confirmed entries (approval-race, carrier-mutation) | zeroY single-app evidence for both, but each represents a *class* of forge (suspended process / non-ledger state) that has shown up in other audits informally |
| Watchlist saga-as-data NOT confirmed | zeroY is N=1 for declarative pipeline-with-compensation. Wait for second app |
| Cookbook entries don't depend on specific specs to merge | otherwise spec churn cascades into cookbook churn; cookbook is optional reading |
| Three graduation tiers (cookbook → patterns pkg → core spec) | matches the actual escalation chain. Skipping tiers (cookbook directly to spec) is allowed when the algebra gap is clearly visible from N=1; should be rare |
| §6 cookbook write sequencing after corresponding spec implementation | recipes that show "use these primitives" need the primitives to exist first. Writing recipes for not-yet-implemented surface generates speculative content that drifts |

---

## Appendix A: explicit non-goals

The following will NOT be cookbook entries under this charter. If they
appear in app evidence, they're separate spec proposals:

- **Authentication / authorization patterns**. Auth is app-domain
  per spec-24 §0; not even a boundary concern.
- **UI / frontend rendering / state management**. spec-24 INV-1
  explicitly out of scope.
- **Build / deploy pipelines**. Wrangler / Vite / etc are app build
  tooling.
- **MCP protocol projection**. MCP is an *output* layer (tools-as-
  MCP-server); it's a thin wrapper over Tool registry that lives in
  app code or a separate package, not in cookbook.
- **Vector / RAG**. Vectorize is a tool the agent calls. Not a
  substrate concern. If multiple apps build the same RAG wrapping,
  it might become a tool helper package, but not a substrate
  cookbook.
- **OTEL exporter setup**. spec-28 §2.5 carries trace context only;
  exporting is the app's `@effect/opentelemetry` config.

If app evidence pushes any of the above toward substrate, that's a
new spec proposal, not a cookbook write.
