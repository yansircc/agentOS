# zeroY N=2 Stability Audit

> **Date**: 2026-05-27
> **Subject**: which agentOS substrate patterns gain N=2 evidence from zeroY,
> which remain N=1, and what new pressure zeroY introduces.
> **Source repos**: vibe-coding-web (`/Users/yansir/code/52/vibe-coding-web`),
> zeroY (`/Users/yansir/code/zeroY`).

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

## Patterns now N=2 (stable evidence)

| Pattern                              | vibe surface                             | zeroY surface                                                                                          |
| ------------------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| LLM transport (OpenAI-compatible)    | `providerTransports*`                    | `ZeroyRuntimeLlmProviderService`                                                                       |
| Tool registry / capability dispatch  | `turnContract.ts` + `toolRegistry.ts`    | `ZeroyAgentSdkCapabilityService` + workflow step `agent_apply`                                         |
| Trace / artifact projection          | `traceLocator.ts`                        | `artifact-projections.ts`                                                                              |
| Credential carried as state-only ref | `tenantCredentialCrypto`                 | `ZeroyRuntimeCloudflareService` + `secretState(value)` presence-only redaction                         |
| **DecisionGate** (approval gate)     | front-door approval flow                 | `wait_for_approval` workflow step driven by `ApplyCandidateApproval`                                   |
| **Scheduled-run composition**        | Cloudflare Workflow + D1 + ledger        | `@effect/workflow` step graph + D1 + CST task state                                                    |
| Context packing                      | `sessionContext.ts`                      | `wordpress-context-contracts.ts` + surface program snapshot                                            |

Two of these (`DecisionGate`, scheduled-run composition) were explicitly
gated on N=2 in spec-36 §12. They graduate now. The others were already in
use but had only one product reference; they now have two and can be cited as
stable cross-app patterns.

---

## Patterns still N=1

| Pattern                                 | Validated by | Held back because                                                            |
| --------------------------------------- | ------------ | ---------------------------------------------------------------------------- |
| `workspace-session-cloudflare` backend  | vibe only    | zeroY uses local locwp:10002, not CF Sandbox. The algebra may still apply, but a port-based local sandbox has not been spike-tested under the same start/restore/backup/preview/destroy invariants. |
| `@agent-os/run-stream` (SSE)            | vibe only    | zeroY uses polling (`editor-agent-status-flow.ts`). The frame algebra is not pressured by a second consumer. |
| skill / MCP registry                    | vibe only    | zeroY has no dynamic capability extension layer.                             |
| Explicit `RuntimeScope` resolver use    | (agentOS)    | zeroY does not expose a scope resolver per se. The pattern is in core but unconfirmed by product code. |

These remain experimental in spec-36 §12. They are not refuted; they are
under-pressured.

---

## New pressure introduced by zeroY

zeroY introduces two patterns that vibe does not exhibit. Both are
composition concerns. Neither is a substrate gap.

### NP1. Compensation workflow

zeroY's pipeline declares a compensation plan as part of the workflow
definition:

```text
agent_apply        -> rollback agent_apply
code_verification  -> (no compensation)
wait_for_approval  -> (no compensation)
locwp_apply        -> rollback locwp_apply
release_canary     -> rollback release
browser_evidence   -> (no compensation)
```

When `locwp_apply` fails, the workflow runner invokes the declared
`rollback locwp_apply` step. This is **not** an EffectClaim phase. It is a
follow-on EffectClaim chain: the rollback is itself an effect with its own
operationRef, authorityRef, anchorRef.

Placement: this stays a saga composition pattern. It does not change
EffectClaim's 3-phase shape. RejectedClaim remains terminal. The compensation
step is a *new* PreClaim with a stable convention linking
`compensation.operationRef → primary.operationRef` via `originRef` or trace
metadata.

Documented as a section in `docs/cookbooks/scheduled-run.md`.

### NP2. Evidence capture

zeroY runs `release_canary` and `browser_evidence` after `locwp_apply`
settles to LivedClaim. These are post-condition validations: HTML reachable,
expected CSS classes present, no console errors. They produce screenshots
and signed evidence references.

Placement: post-condition validation is **another EffectClaim**, not a new
anchor kind. The validating effect has:

- `authorityRef.authorityClass = "verify"` (or carrier-named verify class)
- `anchorRef.anchorKind = "carrier_proof"` pointing to the screenshot or
  probe artifact
- `originRef.originId = primary.operationRef` linking back to the validated
  effect

This avoids inventing a fifth anchor variant or a sixth EffectClaim phase.
Verification stays in the carrier and uses existing primitives.

Documented as `docs/cookbooks/evidence-capture.md`.

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

| Row                  | Evidence       |
| -------------------- | -------------- |
| tool registry        | N≥2 (vibe, zeroY)               |
| DecisionGate         | N≥2 (vibe, zeroY) → graduate    |
| scheduled-run        | N≥2 (vibe, zeroY) → cookbook    |
| compensation         | N=1 (zeroY) → cookbook section  |
| evidence-capture     | N=1 (zeroY) → cookbook          |
| workspace-session-cf | N=1 (vibe)    |
| run-stream           | N=1 (vibe)    |
| skill registry       | N=0           |

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
