# zeroY N=2 Stability Audit

> **Date**: 2026-05-27
> **Subject**: which agentOS substrate patterns gain N=2 evidence from zeroY,
> which remain N=1, and what new pressure zeroY introduces.
> **Source repos**: vibe-coding-web (`/Users/yansir/code/52/vibe-coding-web`),
> zeroY (`/Users/yansir/code/zeroY`).

## Source pin

The audit reads working-tree state, not a pinned commit. Reviewers
reproducing the audit must check against this exact state:

```text
zeroY branch:    codex/surface-coi-typed-op-hard-cut
zeroY HEAD:      b0f2d5d84478c6b5c9a089f7c7ae88114562bb6d
zeroY worktree:  dirty (many M files in apps/, packages/domain/, tools/)
```

The dirty files are all in surface-program / agent-runtime areas and do not
touch `packages/runtime/`, `packages/workflows/`, or `packages/domain/` schema
contracts that this audit cites. If a reviewer re-audits against zeroY `main`
or a different branch and finds divergence in the cited file:line refs, the
audit must be rerun. Findings here should not be cited as "zeroY-main
evidence" until they are reproduced against clean main.

vibe state is not pinned: the vibe references here are based on the prior
file inventory from the round that produced spec-36 §12. They have not been
re-verified against the current vibe HEAD; if vibe has moved, the vibe column
of the tables below may be stale.

---

## Why this note

agentOS substrate algebra was closed by spec-36 (EffectClaim 3-phase, 4 roles,
ScopeRef 5-kind) and spec-37 (MaterialRef). Several materializations
(`@agent-os/decision-gate`, scheduled-run pattern, compensation, evidence
capture) were drafted on the basis of one product's pressure (vibe). The
universality test in spec-36 §1.1 requires N≥2 distinct products before a
materialization is treated as a stable cross-app pattern. zeroY is the second
product. This note records what its runtime layer validates and what remains
N=1.

The audit does not change zeroY or vibe code. It is a record of evidence used
by spec-36 §12 and the cookbook entries.

---

## Method

zeroY's runtime layer lives in `packages/runtime/src/` (Effect.Service
classes) and `packages/workflows/` (step graphs + compensation plans).
`packages/domain/` is business vocabulary; `apps/web` and `apps/wp-*` are
product surface.

For each substrate pattern that was previously N=1 from vibe, we asked: does
zeroY exhibit the same pattern under the same invariants? Same invariants
means: same role (generator/admitter/resolver/reader), same separation of
truth (ledger) from view (projection), same handling of pre-effect vs
post-effect facts.

We did **not** require zeroY to use the same backend. A locwp-based WordPress
sandbox validates the workspace-session shape if the start/configure/cleanup
boundary matches, even though the backend is not Cloudflare Sandbox.

---

## Patterns now N=2 (equivalent invariants)

These rows are validated under the _same_ invariants in both products.

| Pattern                              | vibe surface                          | zeroY surface                                                                                      |
| ------------------------------------ | ------------------------------------- | -------------------------------------------------------------------------------------------------- |
| LLM transport (OpenAI-compatible)    | `providerTransports*`                 | `ZeroyRuntimeLlmProviderService`                                                                   |
| Tool registry / capability dispatch  | `turnContract.ts` + `toolRegistry.ts` | `ZeroyAgentSdkCapabilityService` + workflow step `agent_apply`                                     |
| Trace / artifact projection          | `traceLocator.ts`                     | `artifact-projections.ts`                                                                          |
| Credential carried as state-only ref | `tenantCredentialCrypto`              | `ZeroyRuntimeCloudflareService` + `secretState(value)` presence-only redaction                     |
| **DecisionGate** (approval gate)     | front-door approval flow              | `wait_for_approval` workflow step driven by `ApplyCandidateApproval`                               |
| Context packing                      | `sessionContext.ts`                   | `wordpress-context-contracts.ts` + surface program snapshot (different domain, same packing shape) |

`DecisionGate` was explicitly gated on N=2 in spec-36 §12. It graduates.
The others were already in use but had only one product reference; they
now have a second product validating the same role boundary and the same
truth-vs-projection split.

## Patterns with analogous (not equivalent) pressure

These rows have similar pattern in both products but differ on the fact
store or invariant detail enough that they should not be cited as
equivalent N=2 evidence.

| Pattern                     | vibe                                                 | zeroY                                                                                                          | Why analogous, not equivalent                                                                                                                                                                                                                                                                                                        |
| --------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Scheduled-run composition   | Cloudflare Workflow + D1 + ledger truth + index      | `@effect/workflow` step graph + CST as task truth + workflow runtime evidence as separate typed runtime truth  | zeroY explicitly keeps "CST remains task truth; workflow execution evidence is separate typed runtime truth" (`packages/workflows/src/index.ts:269`). This is the same _scheduler ≠ truth_ principle but a different _truth store_. Cookbook treats CST as the ledger analogue; whether that satisfies spec-36 §1.1 is interpretive. |
| Cloudflare resource control | vibe `cloudflareApi.ts` + per-resource service files | `ZeroyRuntimeCloudflareService` (account/token carrier only; no D1/KV/R2/Queue/Workflow lifecycle ops in repo) | vibe has actual resource lifecycle (provision, mutate, destroy across resource kinds); zeroY currently carries only the credential surface and a D1 binding. The credential-carrying axis matches (and is already counted N=2 above); resource lifecycle is N=1 (vibe only) until zeroY adds CF resource lifecycle ops.              |

---

## Patterns still N=1

| Pattern                                | Validated by | Held back because                                                                                                                                                                                   |
| -------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace-session-cloudflare` backend | vibe only    | zeroY uses local locwp:10002, not CF Sandbox. The algebra may still apply, but a port-based local sandbox has not been spike-tested under the same start/restore/backup/preview/destroy invariants. |
| `@agent-os/run-stream` (SSE)           | vibe only    | zeroY uses polling (`editor-agent-status-flow.ts`). The frame algebra is not pressured by a second consumer.                                                                                        |
| skill / MCP registry                   | vibe only    | zeroY has no dynamic capability extension layer.                                                                                                                                                    |
| Explicit `RuntimeScope` resolver use   | (agentOS)    | zeroY does not expose a scope resolver per se. The pattern is in core but unconfirmed by product code.                                                                                              |

These remain experimental in spec-36 §12. They are not refuted; they are
under-pressured.

---

## New pressure introduced by zeroY

zeroY introduces two patterns that vibe does not exhibit. Both are
composition concerns. Neither is a substrate gap.

### NP1. Compensation workflow

zeroY's pipeline declares **one** compensation edge in its workflow plan:

```text
locwp_apply -> rollback         (compensationFor: "locwp_apply",
                                  mode: "rollback_on_failure")
```

See `packages/workflows/src/index.ts` lines 205-211 (rollback step
declaration), 243-249 (compensation plan entry), and 462 (the
`withCompensation` wrapper applied only around `locwp_apply`). Earlier
drafts of this audit listed `agent_apply -> rollback` and
`release_canary -> rollback` as additional edges; that was an extrapolation,
not actual zeroY code. The catalog has exactly one rollback edge.

When `locwp_apply` fails, the workflow runner invokes the `rollback` step.
This is **not** an EffectClaim phase. It is a follow-on EffectClaim chain:
the rollback is itself an effect with its own operationRef, authorityRef,
and anchorRef.

Placement: this stays a saga composition pattern. It does not change
EffectClaim's 3-phase shape. RejectedClaim remains terminal. The compensation
step is a _new_ PreClaim with a proposed agentOS-side convention linking
`compensation.operationRef → primary.operationRef` via `originRef` or trace
metadata. The convention is motivated by the single zeroY edge; a third
product that compensates would either confirm or refute it. Until then, the
linking shape is a cookbook proposal, not validated cross-product convention.

Documented as a section in `docs/cookbooks/scheduled-run.md`.

### NP2. Evidence capture (proposed, not yet zeroY-validated)

zeroY's workflow catalog declares two post-apply steps:

```text
release_canary     (capability: "release_canary",  evidenceKinds: ["release_canary"])
browser_evidence   (capability: "browser_evidence", after: ["release_canary"])
```

See `packages/workflows/src/index.ts` lines 215-228 (step definitions) and
575+ (`evidenceForStep` produces _synthetic_ evidence refs for current
contract-probe mode). Live execution is explicitly **not implemented yet**:
`packages/workflows/src/index.ts:497` throws when `executionMode === "live"`
with the message "live execution must be wired to runtime services before it
can run". So at HEAD `b0f2d5d`, zeroY exhibits the _intent_ to run
post-condition validation but does not actually execute or settle claims for
verification effects.

Placement: this audit treats post-condition validation as a _proposed
agentOS convention motivated by zeroY's step shapes_, not as
zeroY-validated EffectClaim wiring. The proposed shape, recorded in
`docs/cookbooks/evidence-capture.md`, is:

- `authorityRef.authorityClass = "verify"` (or carrier-named verify class)
- `anchorRef.anchorKind = "carrier_proof"` pointing to the screenshot or
  probe artifact
- `originRef.originId = primary.operationRef` linking back to the validated
  effect

This avoids inventing a fifth anchor variant or a sixth EffectClaim phase
and stays within the existing primitives. The convention will only count as
cross-product evidence after at least one product actually runs
post-condition validation under this shape and produces lived/rejected
verification claims. zeroY can become that first product once
`executionMode: "live"` is wired.

Documented as `docs/cookbooks/evidence-capture.md` (proposed cookbook).

---

## What did not generalize

zeroY's WordPress / locwp adapter (`ZeroyRuntimeLocwpService`,
`ZeroyRuntimeWordPressService`) is N=1 external system. It does not
generalize to substrate. It is the analogue of vibe's
`workspace-session-cloudflare` for WP sites and stays product-owned until a
third WordPress-class app appears.

Surface program / Tailwind compilation, candidate vocabulary, post.upsert /
plugin.write / theme.write operation shapes are business vocabulary. They
belong in zeroY domain, not in any agentOS package.

---

## Consequences for spec-36 §12

The materialization plan annotates each row with evidence:

| Row                           | Evidence                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------- |
| tool registry                 | N≥2 (vibe, zeroY)                                                               |
| DecisionGate                  | N≥2 (vibe, zeroY) → graduate                                                    |
| material ref (credential)     | N≥2 (vibe, zeroY) on the symbolic-ref + presence-only redaction axis            |
| context pack                  | N≥2 (vibe, zeroY) — different domains, same packing shape                       |
| trace/failure plane           | N≥2 (vibe, zeroY)                                                               |
| scheduled-run                 | N=1 (vibe) + analogous pressure (zeroY) — different truth store (CST vs ledger) |
| Cloudflare resource lifecycle | N=1 (vibe) — zeroY only carries credentials, no resource lifecycle ops          |
| compensation                  | N=1 (zeroY, single `locwp_apply` edge) → cookbook section                       |
| evidence-capture              | N=0 validated; proposed convention motivated by zeroY step definitions only     |
| workspace-session-cf          | N=1 (vibe)                                                                      |
| run-stream                    | N=1 (vibe)                                                                      |
| skill registry                | N=0                                                                             |

This is a planning matrix, not a guarantee. Graduation means the cookbook
or package is published with a stability declaration; it does not freeze the
internal types until the next breaking change is justified.

---

## Honest blanks

- The compensation-chain convention (`compensation.operationRef → primary.operationRef`)
  is not yet enforced at the substrate level. It is a cookbook convention. If
  a third product exhibits compensation chains with a different linking
  shape, the convention will need spec-level naming.
- Evidence-capture's `authorityClass: "verify"` is a convention. Other
  authority classes (`probe`, `assert`) might emerge under pressure. The
  cookbook documents the current convention and explicitly avoids freezing
  the class enum.
- locwp-based stateful sandbox may still validate `@agent-os/workspace-session`
  under a different backend. A focused spike (start/restore/backup) would
  decide this. Not in scope for this audit.
