# a84: AG-UI Wire Adapter

## Summary

stable axis: agentOS owns ledger, claims, runtime event schemas, and execution-domain semantics.  
change axis: client/server wire protocol for driving and observing runs.  
invariant: AG-UI is an adapter at the edge, not the source of agentOS runtime truth.

This task depends on a78 runtime event schemas. Do not build AG-UI from fallback payload parsing.

This task also depends on a86a for `AgentSchema -> AG-UI Tool.parameters`
projection. AG-UI tool JSON Schema is a derived projection, not a schema source.

## Key Changes

- Add an AG-UI adapter package or runtime subpath that maps AG-UI `RunAgentInput` into agentOS `submit` input.
- Map agentOS typed runtime events into AG-UI-compatible run events for UI clients.
- Keep attached-stream as the internal stream substrate; AG-UI is a wire-compatible facade.
- Preserve agentOS `Tool.execution`, admission, ledger settlement, and material refs. AG-UI tool shapes must not replace agentOS tool algebra.
- Keep the AG-UI mapping core framework-neutral:
  - core package/subpath produces and consumes AG-UI wire frames only;
  - React binding consumes the core frames and exposes ergonomic hooks/components;
  - Svelte binding consumes the same core frames and exposes stores/actions;
  - React and Svelte bindings must not duplicate frame mapping, schema
    projection, redaction, or submit semantics.
- Pin exact `@ag-ui/core` and `@ag-ui/client` versions, or vendor a recorded
  wire fixture as the compatibility contract.
- Add `docs/concepts/ag-ui-wire-adapter.md`:
  - decoded runtime events are source;
  - AG-UI frames are projections;
  - React/Svelte bindings are client adapters over the same core frames;
  - no AG-UI facts are written to the ledger;
  - field-retention and redaction matrix;
  - product events map through extension/custom frames.
- Add Cloudflare DO facade methods/routes only where needed to expose the adapter without product-specific HTTP assumptions.
- Add web-cursor proof by consuming the adapter for run stream/rendering while keeping product-owned `workspace.file.*` events local.

## Tests

- `RunAgentInput` maps to the same submit behavior as the existing submit facade.
- Runtime event sequence maps to AG-UI frames without losing run id, turn index, tool call id/name/args, tool result, usage, abort, or terminal status.
- Runtime event sequence maps to AG-UI frames without leaking raw ledger payload
  fields outside the explicit field-retention matrix.
- Product deliver events and product workspace events remain extension payloads, not runtime events.
- Malformed runtime event payload fails before AG-UI mapping.
- `AgentSchema -> AG-UI Tool.parameters` projection matches the a86a golden
  fixtures.
- React binding renders the golden frame sequence without re-parsing raw ledger
  payloads.
- Svelte binding renders the same golden frame sequence without re-parsing raw
  ledger payloads.
- React and Svelte bindings share the same framework-neutral mapping fixtures.
- web-cursor can render a run from AG-UI frames after repacking internal packages.

## Gates

Full root gates plus web-cursor consumer check after `pack:internal`.

## Assumptions

- No TanStack AI core dependency is required for a84. The adapter targets the AG-UI wire shape directly.
- UI components remain product or external SDK responsibility.
- agentOS provides React and Svelte consumption bindings only where they are thin
  adapters over the core AG-UI frame stream.
