# Web-Cursor Consumer Proof

## Summary

stable axis: agentOS owns substrate algebra, typed runtime projections,
AgentSchema, AG-UI core frames, workspace tool contracts, material refs, and
redaction policy.  
change axis: product prompts, UI state, workspace projection shape, app routes,
and product-specific file semantics.  
invariant: `web-cursor-workspace-spike` is a consumer pressure app, not a staging
area for new agentOS substrate.

The final web-cursor refactor proves that agentOS is usable from a real product
without forcing that product to reimplement agentOS algebra.

## Role

`/Users/yansir/code/52/web-cursor-workspace-spike` is the primary consumer proof
for this refactor group.

It must prove:

- product code can author tools with `AgentSchema`;
- product code can consume typed runtime projections or AG-UI frames;
- product code can use standard workspace tools from agentOS;
- product UI can render a live run without raw ledger payload parsing;
- redaction policy survives the full API/UI path;
- product-owned workspace file state can remain product-owned.

It must not become:

- an agentOS package staging area;
- a source for substrate event vocabulary;
- a source for `workspace.file.*` carrier promotion;
- a fallback parser for agentOS runtime payloads;
- a separate schema/fingerprint generator;
- a second source for AG-UI mapping semantics.

## Target Consumption Shape

```text
agentOS packages
  -> AgentSchema-authored tools
  -> typed runtime projection / AG-UI core frames
  -> React AG-UI binding in web-cursor
  -> product workspace projection + UI
```

Svelte support is proven against the same core AG-UI frame fixtures. Web-cursor
does not need to migrate to Svelte.

## Required Product Refactor

- Replace raw JSON Schema tool definitions with `AgentSchema`.
- Use standard workspace tools:
  - `edit_file`;
  - `glob_files`;
  - `grep_files`;
  - scan/diff helpers.
- Delete product fallback parsers for agentOS-owned runtime events.
- Replace raw ledger payload UI/API surfaces with:
  - typed runtime projection; or
  - AG-UI frame stream.
- Keep product-specific prompt/system-message design in the product.
- Keep `workspace.file.*` events/projections product-owned.
- Keep file digest/source/removed/hidden-file semantics product-owned until a
  second fs-based product stabilizes the same shape.
- Do not add `WorkspaceFs`, `OverlayFs`, `defineBoundary()`, reconnect/resume,
  `process_start`, or `port_expose` because of this proof alone.

## Live Proof Loop

The live proof should be reproducible as:

```text
inspect -> glob/grep -> edit/write -> verify -> terminal UI
```

Acceptance evidence:

- run id;
- terminal event id;
- screenshot or browser-visible run detail proof;
- workspace diff;
- redaction sentinel result;
- package version or local pack hash consumed by web-cursor.

## Hard Gates

- No `rawPayload` path for agentOS-owned runtime events in product API or UI.
- No product-side parser guesses agentOS runtime payload shapes.
- No product-side raw JSON Schema for agentOS tools.
- No provider URL, credential, resolved material value, file bytes, or
  non-allowlisted provider metadata appears in product API JSON or UI frames.
- No `workspace.file` carrier/package/docs/API is promoted into agentOS from
  this single consumer.
- React and Svelte AG-UI consumption share the same core golden frame fixtures.

## Failure Model

If web-cursor cannot consume agentOS without fallback parsing, the failure is in
agentOS surface design, not in product glue.

Structural fixes should land in agentOS when the missing piece is:

- typed runtime event schema;
- AgentSchema projection;
- AG-UI core frame mapping;
- redaction policy;
- standard workspace tool contract;
- DO RPC return typing.

Product-local fixes are allowed only when the missing piece is:

- prompt design;
- product UI layout;
- product workspace projection semantics;
- product route/API shape;
- app-specific file interpretation.
