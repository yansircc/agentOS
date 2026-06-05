# a86: Effect Schema Canonical Source

## Summary

stable axis: agentOS owns tool identity, execution locus, admission, ledger settlement, material refs, quota, and runtime events.  
change axis: the canonical source for tool parameter schemas and structured-output schemas.  
invariant: Effect Schema is the only schema source; provider JSON Schema, admission fingerprints, decoders, and Effect AI tool projections are derived facts.

This is a breaking refactor. Do not keep a JSON-Schema-first compatibility path.

This task depends on `a86a-agent-schema-profile-spike.md`.

## Key Changes

- Add an agentOS-owned schema surface, either as `@agent-os/schema` or a kernel subpath, that wraps Effect Schema in an `AgentSchema` profile.
- Add `docs/concepts/agent-schema.md`:
  - `AgentSchema` is the only tool/admission schema source;
  - provider JSON Schema and AG-UI tool JSON Schema are derived projections;
  - raw JSON Schema deletion scope excludes undecided non-LLM carrier schemas
    unless a86a widens the scope.
- Replace closed JSON Schema as the public canonical type:
  - `ToolDefinition.function.parameters: object` becomes an Effect Schema / `AgentSchema` source.
  - `SchemaContract` no longer stores a JSON Schema object as the source fact.
  - provider JSON Schema is generated from Effect Schema at the provider boundary only.
- Define the `AgentSchema` profile:
  - allow only Effect Schema features that can produce stable provider JSON Schema, runtime decoding, and fingerprints;
  - fail fast at tool/route/admission boot when unsupported schema features appear;
  - reject lossy constructs instead of silently projecting them.
- Move schema fingerprinting to one generator:
  - Effect Schema source -> canonical JSON projection or canonical AST projection -> stable fingerprint.
  - no hand-written JSON Schema fingerprints.
- Use the fingerprint algorithm and supported feature matrix proven in a86a.
- Update tool definitions created by workspace tools, runtime tests, and product fixtures to use Effect Schema.
- Remove or demote old closed JSON Schema helpers from public API once all internal consumers move.

## Tests

- Two identical Effect Schema sources generate the same fingerprint and provider JSON Schema.
- Equivalent schemas have identical fingerprints across property order, enum/required order, module construction style, and Bun/Node/runtime execution.
- Semantic schema changes change fingerprints.
- Annotation-only changes follow the a86a policy.
- Provider-specific JSON Schema projection differences do not change schema fingerprints.
- Supported object/string/number/boolean/array/enum/union shapes round-trip through runtime decode and provider JSON Schema projection.
- Unsupported Effect Schema features fail at boot with a targeted error.
- `ToolDefinition` cannot be constructed with raw JSON Schema.
- `SchemaContract` cannot be constructed from raw JSON Schema.
- No provider adapter accepts caller-supplied JSON Schema as source.
- No adapter calls `JSONSchema.make` directly; only the `AgentSchema` module may do so.

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

## Assumptions

- This task intentionally breaks existing tool/schema authoring APIs.
- JSON Schema remains allowed only as generated provider projection, not as user or runtime source.
- Raw JSON Schema deletion scope is tool/admission authoring unless a86a explicitly upgrades the scope to all agentOS schemas.
- agentOS runtime ownership does not move to Effect AI in this task.
