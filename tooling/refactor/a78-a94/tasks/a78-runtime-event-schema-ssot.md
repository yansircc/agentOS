# a78: Runtime Event Schema SSOT + Run Projector

## Summary

stable axis: agentOS-owned runtime events are substrate algebra, not unknown external input.  
change axis: runtime event writer/projector/consumer decoding.  
invariant: each runtime-owned event payload has one schema source used for write, decode, and projection.

No compatibility layer and no fallback parser for agentOS-owned event payloads.

## Key Changes

- Add a runtime-owned event vocabulary module exporting kind constants, Effect Schemas, payload types, constructors, and decoders for:
  `agent.run.started`, `chat.ingested`, `llm.response`, `tool.executed`, `tool.rejected`, `agent.run.completed`, and every `agent.aborted.*`.
- `submit-agent` must write these events through constructors/commit helpers only. Remove inline object-literal payload writes for runtime-owned event kinds.
- Add `decodeRuntimeLedgerEvent(event)` returning a discriminated union for known runtime events; product deliver events remain non-runtime `unknown`.
- Move run trace/status/list projection logic from Cloudflare-only `payloadObject` parsing into runtime pure projectors.
- Cloudflare DO `runTrace`, `runStatus`, and `runs` call runtime projectors and map malformed runtime payloads to backend errors.
- web-cursor consumes the decoder/projector and deletes its runtime-event fallback parser. Product-owned `workspace.file.*` handling stays product-local.

## Tests

- Constructor round-trips through `decodeRuntimeLedgerEvent` for every runtime event kind.
- Missing required fields reject during runtime event decode.
- Product deliver events are reported as non-runtime, not malformed runtime events.
- Standard submit, structured submit, timeout aborts, token aborts, and tool errors emit only constructor-backed runtime events.
- Runtime projectors produce the current Cloudflare run trace/status/list behavior for valid events.
- Malformed `llm.response`, `tool.executed`, `tool.rejected`, or terminal runtime payload fails explicitly.
- Grep gate: no direct inline writes for runtime-owned event kind strings in `submit-agent`.

## Gates

```sh
bun run docs:generate
bun run effect-manifests:generate
bun run check
bun run typecheck
bun run test
bun run check:runtime
bun run check:full
effect-skill-scan <worktree> --strict --json --profile
git diff --check
```

Consumer proof:

```sh
bun run pack:internal
cd /Users/yansir/code/52/web-cursor-workspace-spike
bun install
bun run check
```

## Assumptions

- `LedgerEvent.payload` remains `unknown` at the generic ledger boundary because app/product event vocabulary is open.
- Runtime-owned event payloads are internally generated facts. Malformed runtime payload means ledger/storage corruption.
