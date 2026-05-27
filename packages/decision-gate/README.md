# @agent-os/decision-gate

Durable admitter materialization for cross-actor or cross-time approval.

The package provides:

- the `decision_gate.requested / decided / consumed` event vocabulary,
- a reader projection that derives gate state from ledger events,
- an admitter that turns gate state into an `AdmitVerdict`,
- commit helpers backed by spec-34 `ExtensionCapability`.

The core synchronous admitter remains write-free per spec-36 §11 M-2. This
package handles the durable, multi-actor case where the decision is not known
at claim time and arrives later as a ledger fact.

## Stability

`N≥2` per the universality test in spec-36 §1.1.

- vibe front-door / handoff approval flow exhibits the `requested → decided
→ consumed` shape with policy refs and operator decision facts.
- zeroY `wait_for_approval` workflow step over `ApplyCandidateApproval`
  exhibits the same shape with the same role boundaries.

The materialization plan in spec-36 §12 marks this row `N≥2 (vibe, zeroY)`.
External consumers may rely on the event vocabulary, projection shape, and
admitter contract as stable; payload additions stay non-breaking.

The package version remains `0.x` because internal projection caching and
the SDK surface for app-side decision UIs are still under iteration. The
graduation reflects substrate stability, not API freeze. See
`docs/notes/zeroY-n2-stability-audit.md` for evidence detail.

## Invariants

- A decision is a separate ledger fact from the request. The package does
  not own the decision-making policy; the app commits `decided` when the
  policy resolves (operator click, automated rule, quorum tally).
- `consumed` records that the carrier acted on the decision. Once a
  decision is consumed it cannot be re-used; a fresh request must be
  emitted with a new `gateRef`.
- A rejected decision settles the gate carrier's claim as `RejectedClaim`
  with the supplied `rejectionRef`. There is no implicit retry or fallback
  approval.
- The projection is a pure reader. It writes no shadow truth and validates
  every embedded claim before honoring the corresponding event.

## Use with scheduled-run

`docs/cookbooks/scheduled-run.md` shows how to insert a decision gate
between a candidate-producing step and a publishing step. The cookbook also
covers compensation chains for the case where the gate is approved but the
downstream effect later requires unwinding.

## Use with evidence capture

`docs/cookbooks/evidence-capture.md` shows how post-decision verification
can be modeled as a separate `EffectClaim` chain. The gate decides whether
to publish; the verification decides whether the published state is
observable. They are independent.
