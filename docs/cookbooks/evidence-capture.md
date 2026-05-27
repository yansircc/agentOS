# Evidence Capture

> **Status**: **Proposed agentOS convention**, not yet cross-product-validated.
> Motivated by zeroY's `release_canary` and `browser_evidence` workflow
> step definitions, but zeroY at HEAD `b0f2d5d` only declares those steps
> in its workflow catalog — live execution is explicitly pending
> (`packages/workflows/src/index.ts:497`) and produces synthetic refs via
> `evidenceForStep`. No product has actually run post-condition validation
> under this shape yet. Reviewers should treat this cookbook as a *proposal*
> for what verification claims should look like when a product wires them.
>
> **Pattern**: after an external effect settles to LivedClaim, run one or
> more validations that the effect actually achieved its intended
> observable state, and record the validation as its own EffectClaim chain.
> **Uses**: `EffectClaim`, ledger, verification carrier or app-named
> validator.
> **Does NOT introduce**: a fifth `anchorKind`, a sixth EffectClaim phase,
> or a post-anchor "verified" status.

## Invariant

Settlement and observation are different effects.

```text
primary effect      -> LivedClaim with anchorKind = carrier_proof
post-condition test -> a separate EffectClaim that observes the world and
                       settles its own LivedClaim or RejectedClaim
```

Corollaries:

- **V-1.** A LivedClaim from the primary effect means "the carrier reports
  the effect happened". It does **not** mean "the world is in the desired
  state."
- **V-2.** Post-condition validation is a new external effect (read against
  the real system) with its own operationRef, authorityRef, and anchorRef.
- **V-3.** The verification's anchorRef carries the proof (screenshot,
  probe result, schema check, log scrape). The proof bytes stay in the
  carrier; the anchor stores a ref.
- **V-4.** A failed verification produces a RejectedClaim on the
  verification claim. It does **not** retroactively change the primary
  effect's LivedClaim. The primary effect did happen; the world is just not
  in the expected shape.
- **V-5.** Whether to roll back the primary effect on verification failure
  is product policy. The substrate names neither the policy nor a
  "post-verify rollback" anchor kind.

## Why this is not a new anchorKind

A tempting shape is to extend `anchorRef.anchorKind` with
`"verification_proof"` or `"post_condition_passed"`. This collapses two
things that should stay separate:

- the carrier's report that it executed the effect, and
- the world's report that the effect's intended state is observable.

If they share one anchor, then either:

- a passing verification overwrites the primary anchor (loses the carrier
  proof), or
- a failing verification mutates a LivedClaim into something it is not
  (RejectedClaim is supposed to be terminal-pre-execution; mutating a
  Lived to Rejected breaks the §8 state machine).

Keeping verification as a follow-on EffectClaim preserves both records and
keeps phase semantics intact.

## OperationRef and lineage

The verification claim uses its own operationRef, distinct from the primary
effect:

```text
primary.operationRef       = "deploy:site-acme:rev-7"
verification.operationRef  = "verify:site-acme:rev-7:canary"
```

Linkage is via originRef:

```text
verification.PreClaim.originRef = {
  originId:    primary.operationRef,
  originKind:  "verifies",
}
```

A trace reader follows `originRef` to group the verification with the
primary effect. Multiple verifications of the same primary effect each have
their own operationRef and link back to the same primary via originRef. The
ledger does not need a join table for "which verifications belong to which
deploys"; the projection derives it.

## AuthorityRef convention

The verification claim's authority class names the kind of observation:

```text
authorityRef = {
  authorityId:    "verify:browser_evidence" | "verify:canary" | ...,
  authorityClass: "verify",
}
```

`"verify"` is a convention, not a spec-frozen authority class. Spec-36 §5
A-2 explicitly does not freeze the enum. If a third product introduces a
different class for post-condition checks (`"probe"`, `"assert"`,
`"observe"`), the cookbook accommodates the new class without breaking
existing verification chains; the only invariant is that the class is
distinct from the primary effect's authority class.

The admitter for the verification claim decides whether to attempt the
verification at all. A common pattern: the admitter checks that the
primary effect settled to LivedClaim before allowing the verification to
proceed. If the primary settled Rejected, the verification need not run.

## AnchorRef shape

For a passing verification:

```text
anchorRef = {
  anchorId:    "screenshot:rev-7:canary-1",
  anchorKind:  "carrier_proof",
  carrierRef:  "verify:browser_evidence",
}
```

`anchorKind` stays in the existing enum. The verification carrier is the
authoritative owner of the proof bytes. A screenshot lives in R2; the
anchor records the R2 key. A schema check result lives in the verifier's
artifact store; the anchor records the artifact id.

For a failing verification:

```text
rejectionRef = {
  rejectionId:    "screenshot:rev-7:canary-1:diff",
  rejectionKind:  "validation_failed",
  reason:         "expected class .price visible; observed display:none",
}
```

`rejectionKind` stays in the existing enum. `validation_failed` is the
natural fit for post-condition checks because spec-36 §7 names it as the
shape for "the artifact has the wrong structure or the observed world does
not match the expected pattern."

## Compensation interaction

When a verification fails and the product policy is "roll back the primary
effect", the rollback is yet another EffectClaim chain. See the
compensation section of `scheduled-run.md`. The verification's RejectedClaim
is the trigger; the rollback is the response. The substrate does not bake
in any link between the two.

## Multiple verifications

A single primary effect may have multiple verifications (canary smoke +
visual diff + schema check). Each is an independent EffectClaim with its
own operationRef and originRef pointing back to the primary. The product
decides whether all must pass, any may pass, or a quorum is needed. The
substrate sees them as independent claims and projects them as such.

A reader query like "for operationRef X, what verifications ran?" is a
projection over claims where `originRef.originKind == "verifies"` and
`originRef.originId == X`. This is enough to render a verification
dashboard without inventing a join table.

## What this cookbook does not do

- It does not define a `verification.*` event vocabulary. Carriers may use
  carrier-owned vocabularies (`verify.browser_evidence.captured`,
  `verify.canary.passed`, etc.) under spec-34 capability rules.
- It does not require a specific verifier package. zeroY *declares*
  `release_canary` + `browser_evidence` workflow steps that are intended to
  run a browser-side verifier when live execution is wired (currently still
  pending; see `packages/workflows/src/index.ts:497`). A different product
  may use a different verifier; the cookbook only proposes the claim
  shape, not the implementation.
- It does not change the primary effect's settlement. Verification runs
  after the primary LivedClaim is in the ledger.

## Verification (of the pattern itself)

When applying this pattern, the product should be able to answer:

- Does the primary effect's LivedClaim remain in the ledger after the
  verification settles, regardless of outcome? It must.
- Is the verification's RejectedClaim a separate ledger event from the
  primary effect? It must be.
- Can a reader find every verification of a given primary effect by
  following originRef without joining against a verifier-specific table?
  It must be able to.
- If two verifications of the same primary effect run, do they share an
  operationRef? They must not; each is an independent intended effect.

If any answer is "no", the implementation has folded verification into the
primary effect's settlement and lost the §8 state machine guarantees.
