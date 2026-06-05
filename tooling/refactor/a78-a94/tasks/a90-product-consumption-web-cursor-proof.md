# a90: Product Consumption and Web-Cursor Proof

## Summary

stable axis: product code owns product events, product projections, prompts, UI state, and app-specific workspace semantics.  
change axis: product consumption of the new schema/transport/runtime surfaces.  
invariant: product code consumes typed substrate facts and authored Effect Schemas; it does not parse or regenerate agentOS algebra.

This task proves the a86-a89 migration in the current web-cursor pressure test.
Use `web-cursor-consumer-proof.md` as the boundary source for what may remain
product-owned and what must be fixed in agentOS.

## Key Changes

- Repack internal agentOS packages and update `/Users/yansir/code/52/web-cursor-workspace-spike`.
- Treat web-cursor as a consumer proof app, not an agentOS substrate staging
  area.
- Convert web-cursor tool schemas to Effect Schema / `AgentSchema`.
- Consume standard workspace tools from a79:
  - `edit_file`;
  - `glob_files`;
  - `grep_files`;
  - scan/diff helpers.
- Consume typed runtime events from a78; remove fallback parser code for agentOS-owned runtime events.
- Consume AG-UI frames from a84 where available for run stream/rendering.
- Prove the AG-UI React binding in web-cursor and keep the same core AG-UI
  frame fixtures consumable by the Svelte binding.
- Keep `workspace.file.*` product events/projections product-owned.
- Add a hard no-promotion gate: no `workspace.file` carrier, package, docs
  reference, or public API lands in agentOS substrate until a second fs product
  repeats and stabilizes the schema shape.
- Replace raw ledger payload endpoints/streams/toggles with a typed redacted run
  projection or AG-UI frame stream. Product UI must not expose `rawPayload` for
  agentOS-owned runtime events.
- Add or update `docs/guides/build-natural-language-workspace-agent.md`:
  construct tools inside the DO, consume typed run projection/AG-UI, and keep
  product workspace events product-owned.
- Add or update `docs/guides/verify-agentos-app.md` with consumer gates:
  package pin, golden frame mapping, UI render smoke, redaction sentinel, and no
  runtime payload fallback parser.
- Delete product-side schema drift workarounds that only existed because agentOS payload/schema surfaces were untyped.
- Capture live proof evidence:
  - run id;
  - terminal event id;
  - screenshot or browser-visible run detail proof;
  - workspace diff;
  - redaction sentinel result;
  - consumed package version or local pack hash.

## Tests

- web-cursor `bun run check` passes against repacked internal packages.
- Natural-language loop can:
  - inspect files;
  - edit a file;
  - glob/grep files;
  - execute a tool call;
  - render the run detail UI from typed runtime events or AG-UI frames.
- The loop is reproducible as:
  inspect -> glob/grep -> edit/write -> verify -> terminal UI.
- Live proof captures run id, terminal event id, screenshot, and workspace diff.
- React AG-UI binding renders the live proof path in web-cursor.
- Svelte AG-UI binding passes the shared golden frame consumption test, even if
  web-cursor itself remains React.
- Product-owned workspace file projection still updates.
- No product-side parser guesses agentOS runtime event payload shapes.
- No product code authors raw JSON Schema for agentOS tools.
- No web-cursor code owns AG-UI frame mapping semantics beyond consuming the
  core adapter/binding.
- No web-cursor code promotes `workspace.file.*` into agentOS substrate.
- Redaction sentinel proves provider URLs, credentials, file bytes,
  provider-native metadata outside the allowlist, tool args/results outside the
  UI retention matrix, and resolved material values are absent from product API
  JSON and UI frames.

## Gates

```sh
bun run pack:internal
cd /Users/yansir/code/52/web-cursor-workspace-spike
bun install
bun run check
```

Optional live smoke when credentials and local worker bindings are available:

```sh
bun run dev
# run one natural-language file edit/search loop and capture run id + terminal event id
```

## Assumptions

- Product prompt/system-message design remains product-owned.
- Product workspace projection base remains deferred until a second fs-based product stabilizes schema shape.
- This task does not add `WorkspaceFs`, `OverlayFs`, `defineBoundary()`, or reconnect/resume.
- If web-cursor cannot consume agentOS without fallback parsing, treat that as
  an agentOS surface bug unless the missing logic is product prompt/UI/workspace
  semantics.
