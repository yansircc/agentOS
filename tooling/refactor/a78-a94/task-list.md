# agentOS refactor task group

This group combines the existing a78/a79 plan with the latest Codex findings.

Project invariant:

```text
one fact has one owner;
every internal algebra has one code source;
runtime validation is for unknown external input, not internally generated facts;
provider material stays resolver-side and never becomes ledger/projection truth;
runtime mechanical buffers are not truth;
product UI/API consumes redacted projections, not raw ledger payload pass-through.
protocols, SDKs, traces, and workflow frameworks are projections or adapters,
not additional sources of durable truth.
```

Recommended execution order:

The task numbers record discovery order. The sequence below is the logical
execution order and is authoritative when a later-discovered task must run
before an older numbered task.

```text
a78 runtime event schema SSOT + run projector
a79 workspace tools baseline: scan/diff, edit_file, glob, grep, DO RPC return typing
a80 event namespace ownership gate + resource prefix split
a81 provider material boundary hardening
a82 backend commit/fanout contract
a92 durable process algebra
a83 public testing surface + tracked spike hygiene
a84 AG-UI wire adapter + React/Svelte bindings
a85 Effect AI transport replacement spike
a86a AgentSchema profile and projection spike
a86 Effect Schema canonical source
a93 provider output item ADT
a87 Effect AI transport adapter
a88 structured admission on Effect AI
a89 delete old protocol/schema sources
a94 trace context propagation + OTLP projection
a90 product consumption and web-cursor proof
a91 independent subagent architecture review
```

a85 spike has been run. Verdict: `adapter viable, full replacement not viable now`.
Use `effect-ai-spike-verdict.md` as the source for any later Effect AI adapter task.

Follow-up decision: take the breaking path. Effect Schema becomes the only
tool/structured schema source; Effect AI becomes the provider/tool-call
projection. agentOS keeps runtime, ledger, admission, material, quota, and
execution-domain ownership.

Decision source:

- `decisions.md`
- `external-framework-lessons.md`
- `web-cursor-consumer-proof.md`

Unresolved facts must be proven through spikes before production code lands:

- `spike-validation-plan.md`

Gate cadence is defined by:

- `gate-strategy.md`

Phase 6 Authored / Recorded / Live retrofit order and public-surface invariants
are owned by:

- `value-domain-retrofit.md`

Phase 7 authored tree grammar, defaults, normalized manifest provenance, and
conflict rules are owned by:

- `authoring-freeze.md`

The tasks are intentionally independent enough for separate worktrees after a78
and a79. a86, a93, a87, a88, a89, a94, and a90 are ordered and should not run in
parallel against the same schema/transport/provider-output/projection files. a80
should run before any later carrier/provider namespace additions.

When a task can be decomposed into independent read-only scans, protocol
comparisons, or disjoint implementation slices, use all available `gpt-5.5`
`xhigh` subagents. Subagents are part of the expected development loop for this
refactor group, not a last-resort review tactic. The coordinator still owns
invariant synthesis, write-set boundaries, and final acceptance.

Task files:

- `tasks/a78-runtime-event-schema-ssot.md`
- `tasks/a79-workspace-observation-rpc.md`
- `tasks/a80-event-namespace-ownership.md`
- `tasks/a81-provider-material-boundary.md`
- `tasks/a82-backend-commit-fanout-contract.md`
- `tasks/a83-public-testing-surface-and-spike-hygiene.md`
- `tasks/a84-ag-ui-wire-adapter.md`
- `tasks/a85-effect-ai-transport-spike.md`
- `tasks/a86a-agent-schema-profile-spike.md`
- `tasks/a86-effect-schema-canonical-source.md`
- `tasks/a87-effect-ai-transport-adapter.md`
- `tasks/a88-structured-admission-effect-ai.md`
- `tasks/a89-delete-old-protocol-schema-sources.md`
- `tasks/a90-product-consumption-web-cursor-proof.md`
- `tasks/a91-independent-subagent-architecture-review.md`
- `tasks/a92-durable-process-algebra.md`
- `tasks/a93-provider-output-item-adt.md`
- `tasks/a94-trace-context-otlp-projection.md`

Consumer proof:

- `web-cursor-consumer-proof.md`

Deferred:

- `workspace.file` base projection: wait for a second fs-based product and stable
  digest/source/removed/hidden-file semantics.
- `WorkspaceFs + OverlayFs`: wait for multi-file trial/rollback pressure.
- `defineBoundary()`: wait for a second concrete boundary matching the a64/a69
  shape.
- `process_start` / `port_expose`: wait for live preview pressure. This is a
  lifecycle carrier problem, not a `WorkspaceEnv` method and not a new
  `ExecutionDomain` kind.
