# Spec 36: EffectClaim Calculus

> **Status**: Draft v0.1
> **Date**: 2026-05-27
> **Triggers**: pressure from vibe-style session/workspace/tool authority and
> zeroY-style gated publish flows after spec-34 positive package capability.
> **Depends on**: spec-24 section 8 / section 11.1 (scope key conventions +
> stateful carrier safety), spec-28 section 2 (dispatch idempotency), spec-34
> section 1 / section 7 (authorized commit calculus + extension capability),
> spec-35 dynamic-worker boundary, spec-37 material-ref algebra.

---

## 0. Purpose

spec-34 makes ledger writes authorized by capability. It does not yet name the
pre-effect object that asks to perform a side effect. Current call sites carry
that object as adjacent strings:

- `scope: string`
- `idempotencyKey: string`
- tool name / provider / package identity
- trace metadata
- eventual ledger event or carrier proof

Four failures follow if the strings stay unrelated:

1. **Pre-effect identity and post-effect proof collapse.** An optional
   `anchorRef` cannot distinguish "not executed yet" from "will never produce
   an anchor".
2. **Idempotency and trace hierarchy collapse.** A run/turn/attempt path is a
   coordinate for debugging. It is not necessarily the semantic identity of the
   intended effect.
3. **Session-ness leaks back as nullable runtime checks.** If scope remains an
   untyped string, carriers must ask "does this scope have a session
   container?" at runtime.
4. **Authority and origin collapse.** "What permission is claimed" and "who
   emitted the request" are different axes. Folding them together creates
   duplicate gates or boundary leakage.

This spec names the missing algebra. It is a schema decision first, not an
immediate public runtime API expansion.

---

## 1. Invariant

> **Every intended external effect is first a `PreClaim`. Execution settles the
> claim into exactly one `LivedClaim` with an `anchorRef` or exactly one
> `RejectedClaim` with a `rejectionRef`. `anchorRef` is post-effect proof; it
> is never pre-effect authority.**

Stable axis:

- `operationRef` - the intended effect identity
- `scopeRef` - the ownership/lifecycle boundary
- `authorityRef` - the permission being claimed
- `originRef` - the actor or subsystem emitting the claim

Change axis:

- carrier/backend execution shape
- app vocabulary
- provider-specific proof shape
- retention policy

Corollaries:

- **C-1.** A claim phase is explicit. Nullability must not encode state
  machine phase.
- **C-2.** Same canonical `operationRef` means same intended effect. Trace
  coordinates may point at an operation; they do not define it.
- **C-3.** `scopeRef.kind` is the only place where the substrate can branch on
  ownership/lifecycle class. Carriers must not infer this by parsing `scopeId`
  prefixes.
- **C-4.** `authorityRef` is the gate identity. `originRef` is causality. A
  tool, package, or submit loop may be the origin of a claim without owning the
  authority it invokes.
- **C-5.** A successful dry run is lived. Its `anchorRef` points to dry-run
  proof. A missing anchor is not a dry-run marker.
- **C-6.** Rejection is a first-class settlement. Gate denial, validation
  denial, policy denial, and unsupported carrier shape settle as
  `RejectedClaim`; they are not represented by absent proof.
- **C-7.** Execution material is mechanism, not effect identity.
  `PreClaim` keeps the four refs above. Material such as credentials,
  endpoints, bindings, buckets, or queue producers belongs to resolver or
  admitter input via spec-37 `MaterialRef`, not to `operationRef`.

### 1.1 Placement Law

Layer placement is determined by the lowest layer that must know an
information item to maintain its invariants:

```text
layer(X) = lowest layer where X is necessary to maintain writer,
           admitter, resolver, and reader correctness
```

The operational test is not "will several apps use this?" The test is:

- **writer guard** - without `X`, a durable fact namespace can acquire a
  second positive writer or an app can forge a package-owned fact;
- **admitter guard** - without `X`, a pre-effect authority, policy, or
  resource decision cannot be made against the same intended effect identity
  that will later be settled;
- **resolver guard** - without `X`, a typed ref cannot be resolved into
  carrier resources, leases, cleanup roots, or dispatch targets without
  provider-specific parsing;
- **reader guard** - without `X`, trace/audit/workbench projections must write
  shadow facts instead of deriving views from ledger and proof anchors.

Placement follows from the first guard that fails:

| Placement            | Necessary information                                                                                       |
| -------------------- | ----------------------------------------------------------------------------------------------------------- |
| core                 | universal to all effect boundaries because writer, admitter, resolver, or reader invariants fail without it |
| carrier package      | universal to all products using one substrate/provider boundary                                             |
| experimental package | universal to N>=2 products but not yet proven as a stable carrier API                                       |
| cookbook/app         | per-product policy, vocabulary, ranking, UI, or role semantics                                              |

Writer and generator are deliberately separate concepts:

- **writer** is the spec-34 positive commit authority for a durable fact
  namespace. It protects vocabulary ownership.
- **generator** is the spec-36 role that mints or canonicalizes a `PreClaim`.
  It protects effect identity.
- **admitter** is the spec-36 role that consumes a `PreClaim` and returns
  `admitted` or `rejected(RejectionRef)` before execution. It protects
  pre-effect authority and policy.

A package may be both, but only by naming both responsibilities. Conflating
them hides whether the system is protecting fact ownership, effect identity,
or both.

---

## 2. Claim Types

```ts
type EffectClaim = PreClaim | LivedClaim | RejectedClaim;

type OperationRef = string;

interface PreClaim {
  readonly phase: "pre";
  readonly operationRef: OperationRef;
  readonly scopeRef: ScopeRef;
  readonly authorityRef: AuthorityRef;
  readonly originRef: OriginRef;
}

interface LivedClaim extends Omit<PreClaim, "phase"> {
  readonly phase: "lived";
  readonly anchorRef: AnchorRef;
}

interface RejectedClaim extends Omit<PreClaim, "phase"> {
  readonly phase: "rejected";
  readonly rejectionRef: RejectionRef;
}
```

The shared fields are copied into terminal claims intentionally. A terminal
claim must stand alone in a ledger row, trace projection, or carrier proof
index without joining against the pre row to recover its authority or scope.

`EffectClaim` is a claim about one external effect boundary. A pure ledger
`commit(cap, event)` can produce an `anchorRef` when the committed event is
the effect's proof, but ordinary app facts do not need to be wrapped in
claims.

---

## 3. OperationRef

`operationRef` is the canonical identity of the intended effect.

Invariant:

```text
operationRef A == operationRef B  =>  A and B name the same intended effect
```

Rules:

- **O-1.** External `idempotency_key` values are input material, not necessarily
  `operationRef`. A caller that receives a user/provider key must namespace and
  canonicalize it before it becomes an `operationRef`.
- **O-2.** A run/turn/attempt path is trace data. It may be recorded in a
  projection that points at `operationRef`, but it must not be folded into
  `operationRef` unless the product invariant is explicitly "this attempt is
  the semantic effect".
- **O-3.** Provider request ids, ledger event ids, carrier proof ids, and
  workflow step ids are anchors or trace coordinates. They are not
  `operationRef` unless they were minted before execution as the intended
  effect identity.
- **O-4.** Retry uses the same `operationRef` only when retrying the same
  intended effect. A retry that changes the semantic target must mint a new
  operation.

Current mapping:

| Current field                        | EffectClaim role                                    |
| ------------------------------------ | --------------------------------------------------- |
| `DispatchToScopeSpec.idempotencyKey` | input to `operationRef` canonicalization            |
| `ResourceReserveSpec.idempotencyKey` | input to `operationRef` canonicalization            |
| `TraceContext.traceparent`           | derived trace metadata                              |
| `dispatch.outboundEventId`           | sender-local anchor/trace metadata                  |
| `runId / turn / attempt`             | trace projection, not operation identity by default |

---

## 4. ScopeRef

`ScopeRef` is the typed ownership and lifecycle boundary for a claim.

```ts
type ScopeRef =
  | { readonly kind: "realm"; readonly scopeId: string }
  | { readonly kind: "conversation"; readonly scopeId: string }
  | { readonly kind: "session"; readonly scopeId: string }
  | { readonly kind: "artifact"; readonly scopeId: string }
  | {
      readonly kind: "external";
      readonly scopeId: string;
      readonly systemRef: string;
    };
```

Kind semantics:

| Kind           | Owns                                                              | Does not imply                                          |
| -------------- | ----------------------------------------------------------------- | ------------------------------------------------------- |
| `realm`        | durable authority, quota, billing, tenant/app resource boundary   | ordered interaction or stateful runtime                 |
| `conversation` | ordered interaction ledger such as thread/chat/review flow        | sandbox, workspace, preview port, or carrier state root |
| `session`      | resumable runtime/workspace lifecycle and stateful carrier root   | permanent artifact identity or external account         |
| `artifact`     | produced object identity, content/proof lineage, staging output   | permission to execute the artifact                      |
| `external`     | bridge/account/site/project outside agentOS, named by `systemRef` | local carrier state root                                |

Rules:

- **S-1.** `scopeId` stays opaque. The kind is the type-level branch; parsing
  prefixes such as `thread/` or `session/` is compatibility only.
- **S-1a.** Compatibility parsing must fail closed on unknown prefixes. It must
  not default an unknown scope to `realm`; callers with app-defined scope names
  must pass a typed `ScopeRef`.
- **S-2.** Only `session` implies that a stateful execution carrier may declare
  a runtime/workspace root for the scope. Artifact storage can still be
  carrier-backed, but artifact bytes are not a resumable execution session.
- **S-3.** `external.systemRef` is required because the same `scopeId` string
  can exist in multiple outside systems. `site/acme` in Cloudflare and
  WordPress are not the same scope.
- **S-4.** `ephemeral` and `persistent` are not kinds. They are retention or
  lease policy and belong in carrier/session/artifact metadata.
- **S-5.** `workspace` is not a kind in v0. A workspace is a session carrier
  class. Add a separate kind only after N>=2 pressure proves that persistent
  workspace and runtime session have different core invariants.
- **S-6.** Provider names such as `cloudflare`, `sandbox`, `github`, or
  `r2` are not kinds. Provider selection is carrier resolution.

Current scope convention mapping:

| spec-24 convention           | ScopeRef                                                |
| ---------------------------- | ------------------------------------------------------- |
| `user/{userId}`              | `{ kind: "realm", scopeId }`                            |
| `org/{orgId}`                | `{ kind: "realm", scopeId }`                            |
| `thread/{threadId}`          | `{ kind: "conversation", scopeId }`                     |
| `agent/{agentName}/{itemId}` | app-defined; usually `artifact` or `session`            |
| `session/{sessionId}`        | `{ kind: "session", scopeId }`                          |
| `wp/{pluginId}@{siteDomain}` | `{ kind: "external", scopeId, systemRef: "wordpress" }` |

---

## 5. AuthorityRef

`AuthorityRef` identifies the permission being claimed. It is not the actor.

```ts
interface AuthorityRef {
  readonly authorityId: string;
  readonly authorityClass: string;
  readonly version?: string;
}
```

Rules:

- **A-1.** `authorityId` resolves to exactly one gate at the effect boundary.
  Examples: a substrate capability, an extension capability, a tool contract,
  or an app-defined approval policy.
- **A-2.** `authorityClass` is semantic, not provider-specific. Useful classes
  include `read`, `write`, `effect`, `preview`, `deploy`, and `admin`, but this
  spec does not freeze the full enum.
- **A-3.** Tool identity and turn contract are one authority surface. A tool
  registry may store the authority class on the tool entry; it must not add a
  second inconsistent gate downstream.
- **A-4.** Core must not default-admit based on `authorityClass`. Class-specific
  shortcuts such as "read tools are safe" are product policy or explicit helper
  opt-ins, never substrate defaults.
- **A-5.** Package-owned event vocabulary still follows spec-34 section 7. A
  package claim may have an `authorityRef`, but the positive writer remains the
  scoped `ExtensionCapability`.
- **A-6.** Authority contracts may declare required material kinds, but
  material rotation does not change authority identity. The right is
  `AuthorityRef`; the means is `MaterialRef`.

---

## 6. OriginRef

`OriginRef` identifies who emitted the claim. It is not the authority and not
the operation identity.

```ts
interface OriginRef {
  readonly originId: string;
  readonly originKind: string;
  readonly version?: string;
}
```

Rules:

- **G-1.** `originKind` names the emitting subsystem or actor class: app,
  submit loop, dispatch receiver, extension package, tool provider, or human
  operator.
- **G-2.** Per-attempt trace coordinates may be linked from projections, but
  they are not required fields in `OriginRef`.
- **G-3.** An origin may request an authority it does not own only through an
  explicit delegation path. The claim records both axes so the projection can
  show the delegation without inventing a second source of truth.

---

## 7. AnchorRef and RejectionRef

`AnchorRef` is proof that the intended effect happened or that a dry-run proof
was produced.

```ts
interface AnchorRef {
  readonly anchorId: string;
  readonly anchorKind: "ledger_event" | "carrier_proof" | "external_receipt" | "dry_run_proof";
  readonly carrierRef?: string;
}
```

Rules:

- **P-1.** `anchorRef` is created only when settling to `phase: "lived"`.
- **P-2.** Large bytes, full logs, manifests, and responses stay in carriers.
  `anchorRef` stores a ref, not the bytes.
- **P-3.** A dry run uses `anchorKind: "dry_run_proof"` and is still lived.
- **P-4.** `anchorRef`, `payload.claim`, and claim projections must never carry
  resolved execution material: no secret values, live handles, response bytes,
  bucket objects, namespace objects, or provider clients. They may carry only
  symbolic refs, proof ids, fingerprints, or carrier receipts.

`RejectionRef` is proof that the effect did not execute under the requested
authority/scope/operation.

```ts
interface RejectionRef {
  readonly rejectionId: string;
  readonly rejectionKind:
    | "capability_denied"
    | "policy_denied"
    | "validation_failed"
    | "unsupported"
    | "resource_denied"
    | "provider_rejected";
  readonly reason?: string;
}
```

Rules:

- **R-1.** A rejected claim is terminal. Retrying after a semantic change mints
  a new `operationRef`.
- **R-2.** "Unsupported" is an explicit rejection, not a fallback carrier.
- **R-3.** Provider failure after the effect boundary is provider/carrier
  semantics. It may settle as lived with a failure receipt or rejected before
  execution, depending on who owned the effect boundary. The boundary owner
  must specify this in its carrier contract.

---

## 8. State Machine

```text
PreClaim
  -> LivedClaim(anchorRef)
  -> RejectedClaim(rejectionRef)
```

Invalid states:

- `phase: "pre"` with `anchorRef`
- `phase: "pre"` with `rejectionRef`
- terminal claim without the four shared fields
- terminal claim with both `anchorRef` and `rejectionRef`
- `anchorRef: undefined` as a dry-run or denial marker

The state machine may be persisted as one terminal ledger fact, as separate
pre/terminal facts, or as a carrier proof plus ledger ref. The storage layout
is an implementation choice. The type phase is not.

---

## 9. Placement

This spec does not create a new ledger source of truth. It names the claim
shape that future effect boundaries must use.

Correct placements:

- core schema/helper once at least one core call path adopts claim validation;
- tool registry entries that combine tool identity and authority class;
- carrier contracts that need pre-effect dedupe and post-effect proof;
- ledger projections that locate anchors/rejections from committed events.

Canonical envelope:

- **E-1.** When a ledger event carries a claim, it lives at `payload.claim`.
  Readers must look there. Carriers and core generators must write it there.
- **E-2.** If a request accepts both a full `PreClaim` and a legacy standalone
  `scopeRef`, the type must make them mutually exclusive. With a claim present,
  `claim.scopeRef` is the only scope source.

Incorrect placements:

- a separate observability store that duplicates ledger truth;
- provider-specific scope kinds;
- nullable session fields on generic scope objects;
- optional `anchorRef` as phase encoding;
- fallback execution paths that pretend an unsupported claim succeeded.

---

## 10. Completion Fixed Points

There are three completion criteria. They must not be collapsed into one status
column.

```text
substrate complete   = the effect boundary calculus is closed
backend complete     = the product's required primitives have live
                       carrier/provider materializations
composition complete = the product-facing flow wires primitives together
                       without a second source of truth
```

This spec targets substrate completion. A vibe-like product can still need
backend packages or composition packages after this spec is accepted. That is
not a contradiction: missing backend materialization or composition wiring is a
package/product gap, while a missing effect-boundary type is a substrate gap.

Substrate acceptance:

> A new app may add generators, admitters, resolvers, and readers, but must
> not add a new effect-boundary type, nullable phase field, side-channel policy
> field, or second fact source to describe an external effect.

Backend acceptance is product-local. It is satisfied only when that product has
live materializations for the generators, admitters, resolvers, and readers it
needs over this calculus.

Composition acceptance is product-flow-local. It is satisfied only when a
product can consume a coherent run, approval, scheduler, or context flow by
reading agentOS facts and frames, without reintroducing a second run ledger,
second trace store, or side-channel policy source.

---

## 11. Role Algebra

`EffectClaim` has four runtime roles around it. These roles do not replace
spec-34's writer capability; they sit around the pre/post effect boundary.

| Role      | Responsibility                                                                                                   | Must not do                                           |
| --------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| generator | mint or canonicalize a `PreClaim` at an effect boundary                                                          | decide policy by reading unrelated side-channel state |
| admitter  | consume a `PreClaim` and return an admit/reject verdict before execution                                         | write ledger facts or change claim identity           |
| resolver  | turn `*Ref` values into concrete carrier resources, material handles, leases, cleanup roots, or dispatch targets | mint claims unless it is also explicitly a generator  |
| reader    | project claim/ledger streams into trace, audit, workbench, or failure-plane views                                | write durable facts that duplicate the ledger         |

Package names are not substrate ontology. A package is an implementation of one
or more roles on a concrete substrate. The role count should stay stable even
as packages multiply.

Rules:

- **M-0.** A writer is not a generator. A writer owns durable vocabulary via
  spec-34 `ExtensionCapability`; a generator owns claim identity via
  `operationRef`, `authorityRef`, `originRef`, and `scopeRef`.
- **M-1.** A generator owns the boundary where `operationRef` is minted or
  canonicalized.
- **M-2.** An admitter owns the pre-effect decision over an already-minted
  claim. The baseline admitter is synchronous and write-free: it returns a
  verdict, and the caller/carrier settles `RejectedClaim` or `LivedClaim`.
  Durable multi-actor gates are admitter materializations, not a new core run
  status.
- **M-2a.** Malformed admitter verdicts normalize to `RejectedClaim` at the
  claim algebra boundary. Admitter implementation failures are
  `provider_rejected`; policy decisions are `policy_denied`.
- **M-3.** A resolver owns the mapping from typed refs to carrier resources.
  Provider-specific behavior belongs here, not in shared substrate logic.
- **M-3a.** Acquire-side execution material and release-side cleanup are
  separate axes. `MaterialRef` names what a carrier must acquire to execute;
  cleanup roots name how an allocated resource is later released. They may
  later share a lease abstraction, but v0 must not treat cleanup roots as
  material.
- **M-4.** A reader is derived data. Trace locators, failure planes, and
  workbench views read claim/ledger state; they do not become another source
  of truth.
- **M-5.** One package may implement multiple roles only if the roles are
  named separately in its contract.
- **M-6.** Universality is tested by the writer/admitter/resolver/reader guards in
  section 1.1. If an app-specific rule is not required to maintain those
  guards, it remains app-owned even when several apps happen to use the same
  product policy.

---

## 12. Composition Patterns

Composition patterns wire existing primitives into a product-facing flow. They
do not add effect-boundary fields, claim phases, or durable fact sources.

Stable compositions may graduate to packages when their wiring is invariant
across products. Volatile compositions remain cookbooks or app code when their
policy changes by product. Evidence uses the same `N≥2` / `N=1` / `N=0`
pressure vocabulary as the materialization plan below.

| Composition        | Class       | Evidence              | Boundary decision                                                                                                                                                                                                                                                                               |
| ------------------ | ----------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| run-stream         | package     | N=1 (vibe)            | `@agent-os/run-stream` composes post-baseline ledger rows, optional `turn-stream` frames, and the terminal `submit` result into consumer frames; the shipped submit bridge is batched, ledger rows remain durable truth, and turn frames remain non-durable UI/progress data                    |
| scheduled-run      | cookbook    | N=1 (vibe) + analogous (zeroY) | Workflow/alarm may schedule or resume work, but agentOS ledger remains run truth and D1 mirrors are indexes/projections; zeroY exhibits the same scheduler-not-truth principle with CST as task truth, so the analogy is recorded in `docs/cookbooks/scheduled-run.md` without package promotion |
| decision-saga      | cookbook    | N≥2 (vibe, zeroY)     | DecisionGate records requested/decided/consumed facts; product approval policy decides who can approve and when a continuation submit starts                                                                                                                                                    |
| context-pack       | package/app | N≥2 (vibe, zeroY)     | `@agent-os/context-pack` owns deterministic fact packing and redaction spans; product context selection and summarization strategy remain app-owned                                                                                                                                             |
| compensation chain | cookbook    | N=1 (zeroY, one `locwp_apply` edge) | A rejected or failed primary effect may trigger a follow-on PreClaim linked by `originKind: "compensation_of"`; this is a cookbook proposal in `docs/cookbooks/scheduled-run.md`, not a new EffectClaim phase                                                                                  |
| evidence capture   | cookbook    | N=0 validated; proposed | Post-LivedClaim verification is modeled as a new EffectClaim chain linked by `originKind: "verifies"`; zeroY has step definitions only and live execution is pending, so `docs/cookbooks/evidence-capture.md` is a proposed convention                                                          |

Compensation has one zeroY edge (`locwp_apply -> rollback`); evidence-capture
has step definitions but no live execution yet, so it is N=0 validated. Both
will graduate only when product code exercises the same convention with actual
EffectClaim wiring. A different linking shape from a future product (for
example, multi-level compensation-of-compensation or quorum-based verification
consensus) would force the convention into spec-level naming. Until then they
are cookbook proposals that reuse existing core primitives.

A composition pattern graduates to a package only if the shared interface has
more than one nontrivial implementation in distinct products. Today
scheduled-run has analogous pressure from two divergent scheduler/truth
combinations (vibe Cloudflare Workflow + D1 + ledger, zeroY `@effect/workflow`
+ CST task truth) and one cookbook-level shared interface (the ledger-cursor
resume rule). That is not enough common surface for a package; cookbook is the
right shape until convergence happens.

---

## 13. Materialization Plan

The previous six "app runtime gaps" collapse into role materializations over
this calculus. The Evidence column records cross-product pressure per the
universality test in §1.1: `N≥2` means two or more distinct products
exhibit the pattern under the same role and invariants; `N=1` means a single
product has pressured it so far; `N=0` means a planned slot with no live
pressure yet. Source audit: `docs/notes/zeroY-n2-stability-audit.md`.

| Materialization                          | Class       | Role                                 | Evidence              | Boundary decision                                                                                                                                                                                                                  |
| ---------------------------------------- | ----------- | ------------------------------------ | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| tool registry                            | backend     | generator + admitter                 | N≥2 (vibe, zeroY)     | tool identity and turn authority are one boundary schema; contracts are constructed by the registry, and default admission fails closed                                                                                            |
| DecisionGate                             | composition | admitter + reader                    | N≥2 (vibe, zeroY)     | `@agent-os/decision-gate` materializes cross-actor or cross-time approval as `decision_gate.requested/decided/consumed`; core baseline stays synchronous and write-free; vibe's front-door approval and zeroY's `wait_for_approval` validate the same shape |
| runtime scope                            | backend     | resolver                             | N=1 (vibe)            | `ScopeRef` resolves to resource keys, leases, and cleanup roots; provider cases stay outside core                                                                                                                                  |
| workspace session                        | backend     | core claim shape + carrier resolver  | N=1 (vibe)            | `kind: "session"` is the core ownership/lifecycle class; `@agent-os/workspace-session` owns provider-neutral lifecycle facts, projection, and claim settlement; sandbox/workspace/preview/backup resolution stays carrier-specific |
| material ref                             | adapter     | resolver + admitter input            | N≥2 (vibe, zeroY)     | carrier-neutral symbolic refs for execution-time material; never a fifth `PreClaim` field and never a resolved handle in ledger payloads; both products use presence-only redaction for Cloudflare and LLM provider credentials |
| dynamic worker                           | backend     | generator or carrier materializer    | N=1 (vibe)            | bounded stateless Worker execution; not a substitute for session/workspace state                                                                                                                                                   |
| git/deploy/staging/verification carriers | backend     | generator/resolver as needed         | N=1 (vibe)            | adopt claim settlement and proof anchors without app-specific nouns such as `changeId`                                                                                                                                             |
| Cloudflare resource/control plane        | backend     | resolver/materializer for `external` | N=1 (vibe)            | account/site/Worker/resource operations fail closed and anchor proofs in carrier-owned vocabulary; vibe has full resource lifecycle, while zeroY currently carries only the credential surface counted under material ref          |
| context pack                             | composition | reader                               | N≥2 (vibe, zeroY)     | `@agent-os/context-pack` derives prompt context from supplied facts with explicit redaction spans and included/omitted refs; product context strategy stays app-owned                                                              |
| turn stream                              | composition | realtime reader                      | N=1 (vibe)            | `@agent-os/turn-stream` normalizes non-durable token delta frames; ledger facts remain the durable source of truth                                                                                                                 |
| trace locator/failure plane              | composition | reader                               | N≥2 (vibe, zeroY)     | ledger projection only; no parallel observability facts                                                                                                                                                                            |

This table is a planning matrix, not a package list. A future package should
state which role it materializes and which `EffectClaim` fields it owns.

MaterialRef split:

```text
intent:
  operationRef + scopeRef + authorityRef + originRef

mechanism:
  AuthorityContract.requiredMaterials -> MaterialRef -> MaterialResolver
```

The intent side defines idempotent effect identity. The mechanism side defines
which symbolic execution materials a resolver/admitter must acquire or check
before the carrier can run. Credential rotation, endpoint migration, binding
renames, and BYOK changes must not mutate `operationRef` unless the intended
effect itself changes. See spec-37 for the `MaterialRef` contract and redaction
rules.

Workspace-session split:

```text
core:
  PreClaim(start session | restore session | backup session | destroy session)
  -> LivedClaim(anchorRef=sessionRef | backupRef | cleanupRef)

carrier:
  ScopeRef(session) -> workspace root / sandbox / preview port / backup handle
                       / cleanup root
```

The self-resolving claim shape is now accepted: session lifecycle operations
are effects when they allocate, restore, back up, or destroy stateful carrier
resources. The carrier still owns the concrete resource mapping. `workspace`
remains a carrier class under `kind: "session"`, not a new `ScopeRef.kind`.
`ephemeral` and `persistent` remain retention/lease policy, not kinds, because
the same session resolver can support both policies and a session may move
from ephemeral to persistent without changing ownership class.

The v0 package boundary is provider-neutral: `@agent-os/workspace-session`
defines `workspace_session.*` facts, `ScopeRef(session)` resolution, and
claim settlement. Cloudflare Sandbox backup handles, preview routing, local
worktree paths, and restore algorithms are backend packages or app-owned
carrier implementations.

Resolved workspace-session refs may use URI-like strings such as
`agentos://...` or `cleanup://...`, but those schemes are package-owned
conventions. Cross-carrier readers MUST treat resolved refs as opaque strings
and MUST NOT parse scheme or path segments for substrate behavior.

---

## 14. Implementation Stages

| Stage                                   | Ships                                                                                                 | Does not claim                   |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------- |
| P0 - spec                               | this document, including substrate/backend/composition completion criteria and role algebra           | runtime enforcement              |
| P1 - private helpers                    | non-barrel core/internal types and claim validators used by one call path                             | public package API stability     |
| P2 - generator/admitter materialization | tool registry as the first named generator for tool identity and admitter for pre-execution authority | universal carrier migration      |
| P3 - resolver materialization           | runtime-scope and at least one carrier adopting typed `ScopeRef` resolution                           | full workspace/session lifecycle |
| P4 - reader materialization             | trace locator/failure-plane projection over claim/ledger state                                        | second observability store       |
| P5 - carrier migration                  | dynamic-worker/git/deploy/staging/verification/workspace claims and proofs                            | app domain approval policy       |

Do not add a public barrel export before at least one call path uses the type
as an invariant-enforcing boundary. A public unused type would be vocabulary,
not algebra.

Runtime elimination condition: the current string-based `scope` and
`idempotencyKey` fields may remain until an effect boundary has more than one
authority/scope interpretation. At that point, it must adopt `EffectClaim`
rather than add another nullable or provider-specific field.

---

## 15. Verification Matrix

Spec-level checks:

- `anchorRef` appears only on `LivedClaim`.
- `rejectionRef` appears only on `RejectedClaim`.
- `operationRef` is defined as intended-effect identity, not trace path.
- `ScopeRef.kind` includes the five current pressure classes:
  `realm`, `conversation`, `session`, `artifact`, `external`.
- `ephemeral`, `persistent`, `workspace`, and provider names are explicitly
  excluded as v0 scope kinds.
- session/workspace pressure maps to `kind: "session"` without a nullable
  session field.
- workspace-session is split into core session claim shape and carrier
  resolution.
- writer and generator are different guards; package code must not rely on
  claim generation as durable namespace authority.
- generator and admitter are different guards; package code must not decide
  policy before an intended effect has a canonical `PreClaim`.
- dry-run success maps to `LivedClaim` with dry-run proof.
- substrate completion is defined separately from runtime completion.
- new apps may add role materializations but not a new effect-boundary type.
- package planning is expressed as generator/admitter/resolver/reader roles, not a
  fixed list of product capabilities.

Implementation checks for a future P1/P2:

- duplicate `operationRef` returns the same terminal settlement for the same
  intended effect;
- malformed scope kind rejects before carrier execution;
- malformed admitter verdict settles as `RejectedClaim`, never as an
  unhandled post-mint exception;
- missing explicit tool admitter rejects before quota grant and execution,
  regardless of `authorityClass`;
- non-session scopes cannot declare a runtime/workspace root;
- unsupported carrier shape settles as `RejectedClaim`, never fallback success;
- trace projections can locate operation/anchor/rejection without owning a
  second source of truth.
- role implementations declare whether they are generators, admitters,
  resolvers, readers, or an explicit combination.
- material refs are resolver/admitter input, not claim fields.
- authority contracts declare required material kinds without leaking resolved
  material into claim payloads, anchors, or projections.
