# a89: Delete Old Protocol and Schema Sources

## Summary

stable axis: runtime facts, route/material ownership, admission evidence, and execution domains remain agentOS-owned.  
change axis: removal of obsolete manual protocol/schema code after a86-a88 parity is proven.  
invariant: after migration, there is one schema generator and one provider transport path for each supported route.

This task is deletion-first. No legacy wrapper and no compatibility branch.

## Key Changes

- Delete manual OpenAI/Anthropic/Gemini protocol encode/decode modules once Effect AI parity tests pass.
- Delete old JSON-Schema-first canonical helpers and any public exports that let product code author tool/structured schemas as raw JSON Schema.
- Delete duplicated provider usage parsing.
- Delete provider-specific structured forced-tool fallback code that is now handled by the Effect AI adapter.
- Remove old spike-only or compatibility fixtures that construct raw schema objects.
- Keep and harden:
  - `LlmRoute` taxonomy;
  - material resolver;
  - admission lease/evidence;
  - ledger/submit/budget;
  - execution domains;
  - agentOS error taxonomy mapper.
- Add grep gates that prevent old sources from returning.

## Tests

- Old protocol module imports are gone.
- Old JSON-Schema-first public constructors are gone.
- Effect AI adapter parity tests still pass after deletion.
- Runtime submit and structured submit tests pass without old adapter code.
- Docs/public API generation shows no raw JSON Schema authoring surface for tools/admission.
- Effect AI toolkit projection cannot execute tools and cannot erase
  `Tool.execution`; undeclared effectful domains still fail during
  `lowerAgentConfig`.

## Hard Grep Gates

Choose the scope from a86a before applying these gates.

If raw JSON Schema is deleted globally, migrate `BoundaryContract`, carrier
payload schemas, and any other non-LLM schema declarations first.

If raw JSON Schema is deleted only for LLM tool/admission schemas:

```sh
test ! -d packages/backends/cloudflare-do/src/llm/protocol
! git grep -E "ToolDefinition.*parameters.*object"
! git grep -E "SchemaContract.*schema: JsonSchemaObject"
! git grep -E "ToolDefinition.*parameters: object|outputSchema\\?: JsonSchemaObject|SchemaContract.*schema: JsonSchemaObject" -- packages
! git grep -E "defineToolFromDefinition|toClosedJsonSchemaObject|schemaToClosedJsonSchemaObject" -- packages/kernel packages/runtime packages/backends
! git grep -E "./json-schema|JsonSchemaObject|SchemaContract|schemaToClosedJsonSchemaObject|toClosedJsonSchemaObject" -- docs/api packages/*/PUBLIC_API.md docs/surface.json
! git grep -n "readonly parameters: object" -- packages/kernel packages/backends
! git grep -n "readonly outputSchema?: JsonSchemaObject" -- packages/runtime packages/backends
! git grep -n "defineToolFromDefinition" -- packages ':!**/*.test.ts'
! git grep -n "makeSchemaContract({" -- packages ':!**/*.test.ts'
! git grep -n "schema\\.schema" -- packages/backends/cloudflare-do/src/llm
```

Expected result: zero matches for old canonical tool/admission schema/protocol
sources, except in explicit generated projection tests if those remain necessary.

Effect AI deletion gate:

```sh
! git grep -n "disableToolCallResolution: false\\|disableToolCallResolution\\s*:\\s*undefined" -- packages
! git grep -n "usage.*?? 0\\|inputTokens.*?? 0\\|outputTokens.*?? 0\\|totalTokens.*?? 0" -- packages/backends packages/runtime
```

Expected result: zero matches for provider tool execution and zero token-count
fallbacks in production paths.

## Gates

Full root gates plus web-cursor consumer check after internal packages are repacked.

## Assumptions

- This task runs only after a86-a88 have proven parity.
- Deletion is the compatibility strategy. If a route cannot be migrated, it must be explicitly kept as a named exception, not hidden behind a fallback.
