# a58: First-Party Consumer Exception

## Situation

Company product pressure requires one committed vibe-like pressure app before a
second independent consumer exists. The normal substrate rule waits for two
apps with the same shape before lifting product logic into packages, but this
round needs a first-party app to start now.

## Options

- Keep the normal N>=2 rule and delay the product.
- Promote vibe-like product modules directly into substrate packages.
- Add only the shared projection primitive to substrate and keep product modules
  inside a scoped spike with a sunset.

## Decision

Waive N>=2 only for `spikes/vibe-like-agent-app/*`.

The exception scope is this spike only. It lasts 12 months from the first spike
commit and must be reviewed at 6 months. Later products follow the standard
N>=2 rule unless a new decision grants a separately scoped waiver.

Promotion is mechanical: create a promotion decision, evaluate criteria, move
code physically from `spikes/` to `packages/`, update `docs/surface.json`, and
add distribution/docs/API projections if the package is published.

## Kill Criterion

The exception ends if the spike stops being used, product direction changes, or
spike modules are imported as stable packages without a promotion decision.

Any module that misses its review criteria is quarantined to spike-only usage or
retired. It must not become an experimental package by inertia.

## Revisit

Revisit at 6 months, 12 months, and before any module moves to `packages/`.
The 90-day retrospective must record module LOC, API churn count, tool count,
deleted/replaced modules, product usage evidence, and promote/retire candidates.
