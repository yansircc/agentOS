# agentOS In 10 Minutes

## Problem

agentOS is easy to misuse when a reader starts from an adapter, provider, or UI
stream and treats that surface as the source of truth. D10 makes the durable
truth explicit: `invariant.d10.truth-identity` says a run is read through
`scopeRef` plus `effectAuthorityRef`, and `invariant.d10.namespace-integrity`
says `factOwnerRef` is injected by the owning package boundary.

The generated indexes are the quickest route through that model:
[Start Here](../start-here.md) routes intent to recipes, primitives, errors, and
tests. When a reader needs the exact exported symbol, use
`primitive.kernel.LedgerEvent`, `primitive.runtime.Ledger`, or
`primitive.runtime.SubmitSpec` from the generated primitive catalog instead of a
hand-written package table.

## Model

The working loop is:

1. Pick a generated recipe id from [Start Here](../start-here.md).
2. Follow the recipe to the generated primitive ids it names.
3. Read the linked source doc for the invariant behind that primitive.
4. If an `agent_os.*` error appears, use the generated error catalog for the
   invariant and fix path.
5. Verify with the tests listed in the invariant matrix.

The key primitives are small:

- `primitive.kernel.ScopeRef` names the structured scope.
- `primitive.kernel.AuthorityRef` names the effect authority.
- `primitive.kernel.FactOwnerRef` names package ownership.
- `primitive.runtime.Ledger` commits and reads durable facts.
- `primitive.runtime.MaterializedProjectionDefinition` derives observable state.
- `primitive.ag-ui.projectLedgerEventToAgUiEnvelope` projects runtime facts to
  browser-safe AG-UI frames.

Those ids are not a second fact table. They are references into generated docs
whose source is exported TSDoc and `docs/agent/*.source.json`.

## Non-Goals

This page does not teach a compatibility path for old ledger rows. D10 has no
legacy migration and no scope-wide public scan.

This page does not introduce `@agent-os/create`, multi-agent relationship
calculus, `WorkspaceFs`, `OverlayFs`, `defineBoundary()`, or durable
reconnect/resume. Those remain outside the current generated navigation layer.

This page does not replace package docs. Package docs explain package intent;
the generated agent docs route work by invariant and primitive id.

## Related

- [Agent primitives](../agent/primitives.md)
- [Agent error catalog](../agent/errors.md)
- [Agent invariant matrix](../agent/invariant-matrix.md)
- [Durable truth](durable-truth.md)
- [Materialized projections](materialized-projections.md)
- [AG-UI wire adapter](ag-ui-wire-adapter.md)
