# zeroY3 Gated Effect Pressure

> **Date**: 2026-05-26
> **Scope**: pressure `gated-effect-chain` with zeroY3 review/publish shape
> before extracting carrier-owned vocabularies.

## Invariant

zeroY3 can run approve/publish as an app-composed saga:

```text
carrier tools return proof refs
zeroY app commits change.* facts
projection decides readiness / approval / publish terminal state
```

This does not require package-owned `git.*`, `verification.*`, `deploy.*`, or
`staging.*` facts. Those protected vocabularies require spec-34 positive
extension capability before reusable packages can write them.

## Pressure Inputs

The pressure shape comes from current zeroY3 docs:

- `mockup/README.md`: INV-2 linear main/revert, INV-4 diagnostics as
  unfinished conversations, INV-5 explicit change scope.
- `docs/specs/04-agent-workflow.md`: `Composer -> change conversation ->
workspace -> agent run -> verify -> preview -> approve/discard`.
- `docs/specs/05-review-and-staging.md`: approve must require gates, merge,
  adapter apply/readback, production deploy, staging GC; failure remains
  non-live.
- `docs/specs/16-happy-path-acceptance.md`: success requires a user-visible
  terminal artifact, not "agent did not error".

## Spike

Ignored spike:

```text
spikes/_active/a01-zeroy3-pressure/
```

The spike models only ledger rows and carrier proof refs. It intentionally uses
only app-owned `change.*` facts:

```text
change.candidate.recorded
change.gate.recorded
change.ready_for_review
change.approval.decided
change.publish.started
change.publish.step_recorded
change.published
change.publish_failed
```

Verification command:

```sh
scripts/parallel-dev/run-spike-vitest.sh spikes/_active/a01-zeroy3-pressure/vitest.config.ts
```

Result:

```text
Test Files  1 passed (1)
Tests       5 passed (5)
```

## Proven Behaviors

- approve/publish completes using only `change.*` app facts;
- approval before `ready_for_review` does not publish;
- stale `ready_for_review` cannot override a later failed gate;
- duplicate approval does not duplicate publish effects after terminal success;
- publish failure writes `change.publish_failed` and never writes
  `change.published`.

## Vocabulary Extraction

The pressure result supports an initial package vocabulary. The first package
cut declares prefixes, event names, payload shapes, projections, and
Effect-shaped carrier backend interfaces. It does not perform real provider
mutation and does not write ledger facts.

| Carrier package              | Initial vocabulary                                                                                                                 | Projection                 |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `@agent-os/git-carrier`      | `git.workspace.created`, `git.commit.recorded`, `git.merge.recorded`, `git.revert.recorded`, `git.workspace.cleaned`               | `projectGitChange`         |
| `@agent-os/verification`     | `verification.gate.recorded`                                                                                                       | `projectVerificationGates` |
| `@agent-os/staging-artifact` | `staging.artifact.published`, `staging.artifact.reaped`                                                                            | `projectStagingArtifact`   |
| `@agent-os/deploy`           | `deploy.preview.recorded`, `deploy.production.promoted`, `deploy.production.readback`, `deploy.rollback.recorded`, `deploy.failed` | `projectDeploy`            |

These names are now candidate package vocabulary. They should not be treated as
provider-complete until a real zeroY3 approve/publish run produces the same
proof nouns under app-owned facts. Package-owned ledger writes still require
spec-34 positive extension capability.

## Boundary Decision

Positive extension capability is a packageization blocker, not a zeroY3 MVP
blocker.

Next implementation order stays:

```text
1. spec-34 positive capability design
2. gated-effect-chain cookbook
3. zeroY3 app-owned pressure runs
4. carrier package vocabulary extraction
5. multi-worker fan-in only after real workbench query pressure
```

No `awaiting_decision` run status is needed. Approval remains an app fact and
publish remains an app saga.
