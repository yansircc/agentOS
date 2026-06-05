# Gate Strategy

## Summary

stable axis: source ownership, ledger truth, schema identity, provider material
redaction, and tool execution ownership.  
change axis: when a gate runs during implementation and which work can run in
parallel.  
invariant: source-owner gates cannot be deferred; completeness and coverage gates
may move to wave close-out or release close-out to keep refactor velocity.

Task files list the full verification expectation for their close-out. This file
defines the faster development cadence. When there is a conflict, use this file
for inner-loop timing and the task file for final acceptance.

## Non-Deferrable Gates

These gates protect source ownership. They may be narrow at first, but they must
exist as soon as the corresponding source is introduced or removed.

- `AgentSchema` raw JSON Schema ban for tool/admission authoring.
  - Tool/admission APIs must not accept raw JSON Schema as source.
  - JSON Schema is allowed only as a generated provider/AG-UI projection.
- Schema fingerprint determinism for the core fixture set.
  - Equivalent schemas produce the same fingerprint.
  - Semantic changes produce different fingerprints.
  - Unsupported or lossy schema constructs fail before boot.
- Provider material redaction.
  - Provider URLs, credentials, resolved material values, file bytes, and
    provider-native metadata outside the allowlist must not enter ledger-visible
    payloads, projections, AG-UI frames, product API JSON, docs examples, or
    logs.
- Effect AI unresolved-tool boundary.
  - Effect AI may surface tool requests only.
  - It must not execute agentOS tool handlers or normalize provider-executed
    tool results as agentOS tool facts.
- Event namespace ownership.
  - New events must not write under another package's prefix.
  - Known namespace conflicts such as quota must be resolved or explicitly
    recorded before the namespace gate lands.
- Ledger commit/fanout boundary.
  - A committed ledger write cannot be rejected because a post-commit sink
    failed.
  - `transactionSync` and trigger commit callbacks remain synchronous.
- Runtime/admission ownership.
  - Admission writes evidence only.
  - Submit owns deliver, budget abort, and terminal run facts.
- Provider output item ownership.
  - Submit/admission/runtime settlement consume the agentOS provider output item
    ADT, not provider-native response JSON, Effect AI response classes, or
    chat-shaped blobs.
- Trace context propagation and redaction.
  - W3C `traceparent` / `tracestate` is preserved or rejected at boundaries.
  - Trace/export payloads follow the same provider-material and content
    redaction rules as runtime projections.

## Deferrable Completeness Gates

These gates improve coverage and confidence, but they do not define source
ownership. Defer them to the named close-out point.

- Full provider projection snapshots.
  - During a86, keep representative fixtures only:
    object, string, number, boolean, array, literal enum, optional, nullable, and
    supported union.
  - Move OpenAI/Anthropic/Gemini exhaustive projection snapshots to a87/a88.
- Live provider smoke tests.
  - Use golden fixtures and local fake providers during implementation.
  - Run live OpenAI/Anthropic/Gemini smoke only at a87/a88 close-out or release
    close-out when credentials are explicitly enabled.
- AG-UI full UI render proof.
  - During a84, prove typed runtime event -> AG-UI frame golden mapping.
  - Run browser/UI screenshot proof in a90.
- Web-cursor full natural-language loop.
  - Do not run for a79/a84/a86 inner loops.
  - Run in a90:
    `inspect -> glob/grep -> edit/write -> verify -> terminal UI`.
- `check:full`.
  - Do not run every inner loop.
  - Run at wave close-out, before merging a task group, and before release-level
    integration.
- Distribution, npm pack, and public API full diff.
  - Defer to a89/a90 close-out.
  - Earlier tasks use targeted grep/typecheck gates for surfaces they touch.
- a91 independent subagent review.
  - Run only after a78-a94 have landed and passed their close-out gates.
  - Do not run after every task.

## Subagent Cadence

Use all available `gpt-5.5` `xhigh` subagents when work can be split into
independent read-only scans, external protocol/framework comparisons, or
disjoint write scopes.

Good subagent work:

- compare external framework docs against one agentOS invariant;
- scan one boundary for source-owner violations;
- review one package slice with the shared checklist;
- implement a bounded task with an explicitly assigned write-set.

Bad subagent work:

- duplicate the coordinator's immediate critical-path edit;
- edit shared single-writer files without assignment;
- produce generic framework summaries without mapping to agentOS invariants.

The coordinator remains responsible for:

- stable/change/invariant synthesis;
- deciding rewrite boundaries;
- enforcing write-set isolation;
- merging findings by failure class;
- final gate selection and acceptance.

## Development Cadence

Use this inner loop while editing:

```sh
bun run typecheck
bun run test -- <touched package or test pattern>
<focused grep/source-owner gate>
git diff --check
```

Use this at a task or wave close-out:

```sh
bun run check
bun run test
effect-skill-scan <worktree> --strict --json --profile
git diff --check
```

Add runtime gates when a change touches runtime harness code, Durable Object
behavior, storage, Wrangler config, runtime facades, provider adapters, or
transaction/fanout behavior:

```sh
bun run check:runtime
```

Use release-level gates only when closing a large wave or before merge/release:

```sh
bun run docs:generate
bun run effect-manifests:generate
bun run check:full
<distribution/public-api gates>
<web-cursor proof when applicable>
<a91 review after a78-a94>
```

## Rule

Source-owner gates are not deferrable. Coverage/completeness gates are
deferrable to the wave or release boundary named above.
