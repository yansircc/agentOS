# Plan: a07-n2-stability

> **Worktree**: `parallel/a07-n2-stability`
> **Status**: documentation-only; no source or schema changes; no version
> bumps.
> **Reviewer goal**: confirm the N=2 evidence record is faithful, the
> cookbooks reuse existing primitives, and the spec-36 §12 table reflects
> the audit without overreaching.

---

## Why this worktree exists

agentOS substrate algebra closed in spec-36 (3-phase EffectClaim, 4 roles,
5-kind ScopeRef) and spec-37 (MaterialRef). Several materializations had
been drafted on the basis of **one** product's pressure (vibe). Spec-36 §1.1
requires N≥2 distinct products before a cross-app materialization is treated
as stable.

zeroY (`/Users/yansir/code/zeroY`) is the second product. Its runtime layer
(`packages/runtime/`, `packages/workflows/`) exhibits several patterns vibe
already pressured plus two new ones (compensation chain, evidence capture)
that vibe did not surface.

This worktree records the audit and graduates two patterns from
"experimental / N=1" to "stable / N≥2" without changing code, schema, or
APIs. It also writes the two new pattern cookbooks before they drift apart
in product-local code.

The trigger was the prior round's verdict: zeroY validates
`@agent-os/decision-gate` and the scheduled-run composition pattern. Both
were explicitly gated on a second product. The second product arrived.

---

## What changes

| Change                                               | Surface          | Risk |
| ---------------------------------------------------- | ---------------- | ---- |
| Add `docs/notes/zeroY-n2-stability-audit.md`         | docs only        | none |
| Add `docs/cookbooks/scheduled-run.md`                | docs only        | none |
| Add `docs/cookbooks/evidence-capture.md`             | docs only        | none |
| Edit spec-36 §12/§13 to add Evidence on top of Class | spec doc         | low  |
| Add `packages/decision-gate/README.md`               | package doc only | none |

No source files, no `package.json` versions, no schemas, no migrations, no
test additions. The package's TypeScript surface, exported events, and
projection API remain bit-identical to `b5da6ad`.

---

## What this worktree does NOT do

- **No package promotion of scheduled-run.** zeroY and vibe use divergent
  schedulers (`@effect/workflow` vs Cloudflare Workflow). The shared
  invariant is one cookbook-level rule (ledger truth, scheduler intent,
  derived index). That is not enough common surface to warrant a package.
  Cookbook is the right shape until backends converge.

- **No new compensation primitive in core.** Compensation chains stay as a
  cookbook convention using existing `originRef` linkage. RejectedClaim
  remains terminal. EffectClaim phases stay at three. If a third product
  exhibits a different compensation linking shape, that triggers
  spec-level naming; today's evidence is N=1 (zeroY only).

- **No new `anchorKind` for evidence capture.** Post-condition validation
  is a new EffectClaim chain, not a fifth anchor variant. The cookbook
  documents the convention using existing anchorKind values
  (`carrier_proof`) and existing rejection kinds (`validation_failed`).

- **No bump from N=1 to N≥2 for unverified rows.** `workspace-session`,
  `runtime-scope` resolver, `dynamic-worker`, `git/deploy/staging` carriers,
  `turn-stream`, and `skill registry` remain N=1 (or N=0). zeroY does not
  pressure them under the same invariants and they stay experimental.

- **No edits to vibe or zeroY.** This is a record of evidence from
  reading their structure, not a refactor.

---

## Commit shape

Five originally-shipped commits plus one review fix-up commit:

1. `docs(notes): record zeroY n=2 stability audit`
   adds `docs/notes/zeroY-n2-stability-audit.md` and this plan note
   (originally drafted as root `Plan.md` in the worktree).

2. `docs(cookbooks): add scheduled-run with compensation chain section`
   adds `docs/cookbooks/scheduled-run.md` including the compensation
   convention.

3. `docs(cookbooks): add evidence-capture pattern`
   adds `docs/cookbooks/evidence-capture.md`.

4. `docs(spec-36): record n=2 evidence; reference composition cookbooks`
   edits spec-36 §12/§13 to add Evidence on top of the composition Class
   split from a16.

5. `docs(decision-gate): declare n=2 stable in package readme`
   adds `packages/decision-gate/README.md`.

6. `docs(audit): tighten zeroY evidence claims per codex review` (fix-up)
   responds to codex's review of commits 1-5:
   - pins zeroY branch/HEAD/dirty state in the audit;
   - narrows compensation evidence from a fabricated three-edge example
     to the single `locwp_apply -> rollback` edge actually present at
     `packages/workflows/src/index.ts:205-249`;
   - reframes evidence-capture as a proposed agentOS convention motivated
     by zeroY step definitions, not as zeroY-validated EffectClaim chains
     (live execution is still pending at `index.ts:497`);
   - downgrades scheduled-run from N≥2 to "N=1 (vibe) + analogous (zeroY)"
     and Cloudflare resource/control plane from N≥2 to N=1 (vibe only
     has resource lifecycle; zeroY carries the credential surface, already
     counted under material ref);

- updates the plan note's commit count to reflect the actual six commits.

This plan note was originally committed as root `Plan.md` in commit 1 so the
reviewer had context from the first change forward. It moved under
`docs/notes/` during a16/a07 integration so `main` keeps durable planning notes
inside the documented docs surface.

---

## LGTM criteria

A reviewer should be able to answer "yes" to each:

- Does the audit note accurately describe what zeroY does in its
  `packages/runtime/` and `packages/workflows/` layers? Cross-check against
  the file inventory listed in the audit.
- Do the two new cookbooks reuse only existing primitives (EffectClaim,
  originRef, anchorKind, rejectionKind)? No new types, no new anchor or
  phase variants?
- Does the spec-36 §12 table's Evidence column match the audit's findings,
  or does it overreach (claiming N≥2 where zeroY does not actually
  exhibit the pattern under the same invariants)?
- Does the decision-gate README's "Stability" section restrict itself to
  N=2 evidence and not freeze internal types or version?
- Are the patterns that remain N=1 explicitly listed as such, with the
  reasoning for holding back?
- Did this worktree avoid changing any source, schema, or test? Verify
  with `git diff --name-only b5da6ad...HEAD` showing only `docs/` and one
  package README.

If any answer is "no", reject. If all are "yes" but the reviewer thinks
the audit overreaches on a specific row, the right response is to demote
that row back to N=1 in commit 4 rather than block the rest.

---

## Verification commands

The worktree has no source changes. The relevant gates:

```sh
# from worktree root
git diff --name-only b5da6ad...HEAD          # docs-only diff
git diff --check                              # no whitespace damage

# spec-36 still parses as Markdown
test -f docs/specs/spec-36-effect-claim-calculus.md

# cookbooks are reachable from the index list
ls docs/cookbooks/scheduled-run.md docs/cookbooks/evidence-capture.md

# decision-gate package still typechecks (no code changed but README is
# next to package.json so verify the workspace still resolves)
cd packages/decision-gate && bun run typecheck && bun run test
```

No `bun run test` at root because no source changed; relying on the
previously-green `b5da6ad` test state.

---

## Honest blanks

- The audit treats locwp-based stateful sandbox as N=1 (not validating
  `workspace-session-cloudflare`). A focused spike that maps locwp's
  start/configure/cleanup shape onto the workspace-session algebra would
  decide whether to promote that row. Not in scope here.
- The compensation linking convention (`originKind: "compensation_of"`)
  has only N=1 evidence. If zeroY's actual implementation uses a
  different field name, the cookbook needs to either match that or
  declare a new convention before zeroY can adopt it without churn.
  Decision: ship the cookbook with the convention and let zeroY-side
  integration shake out any mismatch.
- The evidence-capture cookbook uses `authorityClass: "verify"` as a
  convention. zeroY's `release_canary` and `browser_evidence` may use a
  different class name internally. Same shake-out caveat.

These blanks are why the work stays at cookbook + readme level rather
than crystallizing into package interfaces. Cookbooks tolerate
convention adjustment; packages do not.

---

## After LGTM

Merge `parallel/a07-n2-stability` into `main` after `parallel/a16-composition-frontier`.
The a07 rebase must keep one scheduled-run cookbook by folding a16's
consumer-stream boundary into `docs/cookbooks/scheduled-run.md` and deleting
`docs/cookbooks/scheduled-run-composition.md`. No follow-up branches are
required; downstream integration work (`zeroY-side` or `vibe-side` strangler
steps) lives in product repos, not in agentOS.
