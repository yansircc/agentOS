# Spec 26: img-gen substrate audit

> **Status**: Audit accepted (drafted 2026-05-25, framing v2;
> spike-07 implemented 2026-05-26; live smoke passed 2026-05-26)
> **Next**: [spec-28-img-gen-gap-implementation-plan.md](./spec-28-img-gen-gap-implementation-plan.md)
> **NOT refactor**. The goal is to identify 0-N real substrate gaps that
> arise when expressing img-gen's pipeline shape, NOT to land img-gen on
> agent-OS.

---

## 0. Purpose

Find substrate gaps under a strict invariant. The audit's product is the
gap list (and the smallest primitive that removes each gap), not running
code in `/Users/yansir/code/52/img-gen/`.

The shift in framing matters: it stops us from optimising for LOC,
"agent-OS style", business completeness, or product polish — none of
those measure substrate completeness.

---

## 1. Invariant — what counts as a gap

> **An app exhibits a substrate gap if, to express a generic control-flow
> or state-ownership concern, it MUST do any of:**
>
> 1. **maintain a second SSoT** synonymous with `events` (mutable status
>    columns that duplicate ledger truth),
> 2. **hand-roll a compensation protocol** (best-effort try/catch around
>    a resource change that should be atomic by construction),
> 3. **forge cross-boundary glue** (Service Binding RPC, queue
>    producer/consumer pairs, scope-routing tables) that the substrate's
>    public surface does not express,
> 4. **enumerate a capability table** (model whitelists, endpoint
>    registries written by hand) that the substrate's evidence/projection
>    pattern is supposed to replace.
>
> Anything else is an **app concern**, no matter how much code it
> occupies in the source repo.

This is sharper than "img-gen has 5000 LOC that agentOS could shorten."
Code that's only there because the substrate doesn't have a primitive
**will look like the four shapes above**, not like generic verbosity.

---

## 2. Three-tier classification

| Tier | Rule | Examples (from img-gen survey) |
|---|---|---|
| **Not a gap** | App-domain: prompt content, UI, business schema, provider parameters, image style, moderation policy, payment vendor | 7Pay webhook, Better Auth, `ImageWorkspace.tsx`, `google/nano-banana` provider params |
| **Candidate gap** | Looks like generic infrastructure that *might* fit one of the four shapes above | cross-DO event routing, durable outbox, credit reservation/settlement, artifact carrier contract, provider idempotency, queue-consumer ledger ownership |
| **Confirmed gap** | App MUST maintain a state table synonymous with `events`, OR MUST compensate non-atomic resource change with best-effort try/catch | C1/C2 cross-DO durable delivery, C3 resource reservation/release, C5 image-output route |

The substrate ships **only confirmed gaps**, never candidate gaps.

---

## 3. Method — falsification spike

Reading img-gen's source can identify candidates but cannot confirm gaps,
because we can't tell from existing code whether the substrate *would
have forced* the same pattern. Two paths could have produced the same
result.

To confirm, we **build a minimal spike** in agent-OS that mimics img-gen's
happy path and observe where the substrate forces one of the four shapes
in §1. Each forced shape becomes a confirmed gap, with the spike code
itself as the evidence.

The spike is **not** an attempt to build img-gen. It's a stress test of
the substrate, scoped to falsify or confirm candidate gaps from §4.

---

## 4. Candidate gaps to falsify

Derived from the img-gen pipeline survey (see survey agent output in
session 2026-05-25). Each candidate must be tied back to concrete img-gen
source lines before it can be promoted by the spike.

| # | Candidate | Hypothetical primitive | What it would express |
|---|---|---|---|
| C1 | Cross-DO durable delivery | `dispatchToScope(targetScope, event, data)` atomic with current scope's ledger write | session-DO → user-DO credit reservation; session-DO → consumer-DO job dispatch |
| C2 | Durable outbox (transactional enqueue) | expected implementation hypothesis of C1 (sender ledger atomically writes outbound intent; drain delivers; receiver idempotently ingests) | the "queue_outbox" table img-gen hand-rolls |
| C3 | Quota refund / release | `Quota.release(scope, key, amount)` writes `dispatch.released` event | failure-path compensation for reserved credit |
| C4 | Blob carrier (R2) | `R2Carrier` matching INV-9 / §11.1 C1-C4 | scope-namespaced artifact write/read, cleanup primitive |
| C5 | Image-output route | new image-output route variant + binary-response decoder (`LlmRoute` may later be renamed if the generic concept is broader, e.g. `AiRoute`) | env.AI.run returning image bytes / blob refs, currently outside Chat Completions schema |

C1 and C2 intentionally start as separate candidates but may collapse. Cross
ledger delivery has no distributed transaction, so the likely generator is:
sender ledger records an outbound intent atomically, infrastructure drains it,
receiver ledger idempotently ingests it. If the spike confirms that shape,
C2 is not a second primitive; it is the internal mechanism of C1.

Three possible outcomes per candidate after spike:

- **Confirmed gap** — substrate had to be bypassed; app forged one of the
  four shapes from §1. Becomes a post-audit substrate proposal.
- **Not a gap** — substrate's existing primitives express it cleanly,
  possibly with one helper function in app space. Stays as app concern.
- **Disguised gap** — surfaces as a different shape than predicted (e.g.,
  what looked like cross-DO turned out to be cross-Worker on top of
  Service Binding + RPC; or a single primitive collapses two candidates).
  Document the actual shape.

### 4.1 Spike 07 verdict

| Candidate | Verdict | Reason |
|---|---|---|
| C1 cross-DO durable delivery | **confirmed** | The spike must use direct DO RPC between ledger-owning scopes. Sender ledger, delivery intent, and receiver ingest are not one substrate fact. |
| C2 durable outbox | **disguised duplicate** | Same generator as C1. Durable outbox is the likely implementation mechanism for cross-ledger delivery, not a second public primitive. |
| C3 quota refund / release | **confirmed** | Existing quota is dispatch pre-consumption. img-gen needs reserve now, consume or release later for a business resource. |
| C4 R2 blob carrier | **not a gap** | R2 is an INV-9 carrier: bytes live outside the ledger; ledger stores artifact refs. |
| C5 image-output route | **confirmed** | Image generation is provider route capability and binary response decoding, not Tool execution. |

---

## 5. Spike — `spikes/07-img-gen-shape/`

**Goal**: implement the happy path of img-gen using ONLY agent-OS public
surface. Where a primitive is missing, mark it `// GAP-Cn: <description>`
and continue with the smallest workaround. Do NOT route around — leave
the workaround visible so the spike code IS the audit report.

The spike's workaround line is not enough by itself. Every confirmed gap
must cite both:
- the img-gen source line that demonstrates the real app forges the shape,
- the spike line where agentOS public surface still forces the same forge.

**Stages to express** (happy path only — no error compensation, no auth,
no UI):

```
1. POST /request {prompt, nImages}
     → sessionDO.emitEvent("image.request.created", {prompt, nImages})

2. on("image.request.created")
     → submit({ outputSchema: PlanSchema, route: <real route> })
     → emits "image.plan.ready" with the decoded plan

3. on("image.plan.ready")
     → reserve credit for nImages
       ↳ candidate gap C1 (if credit lives in another DO)
       ↳ candidate gap C3 (if substrate Quota can't express reservation
                            vs. consumption)

4. on("image.credit.reserved")
     → dispatch one job per image to the consumer
       ↳ candidate gap C1 (cross-DO; recipient is an AgentDOBase subclass)
       ↳ candidate gap C2 (durable outbox)

5. consumer receives job
     → calls image provider route (spike uses GAP-C5 shim until route exists)
       ↳ candidate gap C5 (binary response shape)

6. consumer writes artifact to R2
       ↳ candidate gap C4 (R2 carrier)

7. consumer dispatches back to sessionDO
       ↳ candidate gap C1 again (cross-DO reverse)

8. on("image.delivered")
     → settle credit (debit reserved, refund unused)
       ↳ candidate gap C3 (refund/release)
```

**Spike files**:

```
spikes/07-img-gen-shape/
├── README.md             — gap counters, audit notes per stage
├── package.json
├── tsconfig.json
├── wrangler.jsonc        — bindings: SESSION_DO, USER_DO, CONSUMER_DO,
│                          AI, ARTIFACTS
├── worker.ts             — HTTP routes + SessionDO + UserDO +
│                          ConsumerDO classes
├── schemas.ts            — PlanSchema (LLM structured output)
├── test.sh               — one happy path, ~5 assertions:
│                          request → final artifact URL in ledger
└── GAPS.md               — confirmed gaps grow here as spike progresses;
                            structured: shape (§1 #), code citation,
                            minimal primitive proposal
```

**What the spike is NOT**:
- not a refactor of img-gen
- not a complete app
- no failure-path compensation (separate audit pass; happy path first)
- no auth, no billing-vendor, no UI
- no LOC reduction claims

**Acceptance** (audit ends when):

- spike runs the happy path against agent-OS substrate. The planning step may
  use a real chat-compatible route (gpt-4.1 via OpenRouter is fine). If C5 is
  confirmed before substrate implementation, image generation stays as an
  explicit local/provider shim marked `GAP-C5` rather than pretending agentOS
  already has an image-output route.
- `GAPS.md` has 0-N confirmed gaps, each with:
  - the shape it violates (§1 #1–#4)
  - the img-gen source citation that motivated the candidate
  - a citation to the spike line where the forge happens
  - the minimal primitive that would remove the forge
- candidate list in §4 is fully resolved: each item is moved to
  **confirmed / not a gap / disguised**
- no substrate code has changed during the audit

After the audit, we decide which confirmed gaps deserve post-audit
implementation, in what order, with what design. THAT decision is its
own document, not part of this audit.

---

## 6. Non-deliverables

This audit explicitly **does not** produce:

- a refactored img-gen
- a "if we had X, img-gen would be Y LOC shorter" estimate
- proposed substrate primitive implementations (only minimal API sketches
  per confirmed gap)
- decisions on which gaps to ship — that's the post-audit decision
- a critique of img-gen's design — different goal, different scope

---

## 7. Spike assumptions fixed before implementation

These are not spike questions. They are the assumptions the spike is allowed
to falsify.

1. **Image-binary is a route capability, not a Tool.** Tool execution is an
   app/carrier effect after an LLM decision. Image generation is the model
   provider route itself: protocol, provider request shape, binary response
   shape, and capability evidence belong on the same axis as text / structured
   generation. The route name may widen later (`AiRoute`, `ModelRoute`), but
   the primitive class is route, not Tool.
2. **Cross-DO recipient must be an `AgentDOBase` subclass.** If the recipient
   is not a ledger-owning DO, the event truth ends at the boundary and the
   recipient is an INV-9 carrier / external system. That may be a valid app
   integration, but it is not a substrate cross-ledger primitive.
3. **Scope hierarchy is orthogonal.** `user/{userId}`, `session/{sessionId}`,
   and `job/{jobId}` are app-owned scope names. The substrate does not know
   parent/child relationships. A relationship such as "session belongs to
   user" is represented as an event payload in the owning ledger, e.g.
   `session.bound_to_user { userScope }`.

---

## 8. Audit status

The spike implementation exists at `spikes/07-img-gen-shape/`.

Current status:

1. Candidate classification is resolved in §4.1 and
   `spikes/07-img-gen-shape/GAPS.md`.
2. The spike is typecheckable with the current substrate.
3. Live happy-path smoke passed against `spikes/07-img-gen-shape/.dev.vars`
   OpenRouter credential:
   - `POST /request` accepted
   - session ledger emitted `image.delivered`
   - user ledger emitted `credit.reserved` and `credit.consumed`
   - consumer ledger emitted `image.artifact.written`
   - `PASS: 6  FAIL: 0`

The audit is accepted under §5's live-smoke criterion. Implementation order
and per-gap acceptance are owned by
[spec-28](./spec-28-img-gen-gap-implementation-plan.md).
