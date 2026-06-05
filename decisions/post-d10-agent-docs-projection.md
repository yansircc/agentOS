# Post-D10 Agent Docs Projection

## Situation

D10 made ledger truth identity and namespace integrity explicit, but agents still
needed a mechanical way to route from intent to primitive, invariant, error, and
test. Package docs and API docs were already governed, but they were organized
by package rather than by task.

Without generated agent indexes, future agents would rebuild the same map by
reading `docs/surface.json`, package manifests, TSDoc, and tests manually. That
would make documentation navigation a parallel source of truth.

## Options

- Keep agent routing as hand-written docs.
- Generate agent-facing indexes from repo source facts.
- Defer agent docs until `@agent-os/create` exists.

## Decision

Generate the agent-facing route layer. `docs/agent/*.source.json` owns recipe,
invariant, error, and external vocabulary source facts. Exported TSDoc tags own
primitive ids such as `primitive.kernel.LedgerEvent` and
`primitive.runtime.SubmitSpec`. `scripts/generate-agent-docs.mjs` owns the
generated projections:

- `docs/start-here.md`
- `docs/agent/recipes.json`
- `docs/agent/primitives.json`
- `docs/agent/primitives.md`
- `docs/agent/errors.json`
- `docs/agent/errors.md`
- `docs/agent/invariant-matrix.json`
- `docs/agent/invariant-matrix.md`

Hand-authored docs may explain the model and external mappings, but must cite
generated ids instead of copying primitive, error, or invariant tables.

## Kill Criterion

If an agent-facing index must be updated by hand after a primitive, error, or
invariant source changes, the generator is incomplete and must be extended
before adding more hand-authored docs.

If two generated ids need aliases that cannot be represented in TSDoc or
`docs/agent/*.source.json`, add a source schema field before adding another
manual explanation page.

## Revisit

Revisit when `@agent-os/create` starts consuming recipes, when a second external
protocol needs first-class generated routing, or when `defineBoundary()` becomes
a concrete primitive with generated docs requirements.
