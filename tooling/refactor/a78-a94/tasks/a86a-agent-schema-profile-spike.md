# a86a: AgentSchema Profile and Projection Spike

## Summary

stable axis: agentOS owns schema authority, decode semantics, admission fingerprints, and provider projection boundaries.  
change axis: the allowed Effect Schema feature subset and projection algorithms.  
invariant: one `AgentSchema` source derives runtime decode, canonical fingerprint projection, Effect AI tools, AG-UI tool JSON Schema, and provider JSON Schema; no derived projection is source truth.

This spike must run before a86 implementation.

## Scope Decision

This spike answers whether raw JSON Schema is deleted globally or only from LLM
tool/admission authoring.

Current expected scope: raw JSON Schema is deleted from tool/admission authoring.
Non-LLM substrate schemas such as `BoundaryContract` payload declarations may
remain until a separate schema-owner task decides their source.

## Spike Questions

- Which Effect Schema AST nodes are allowed for tool/admission schemas?
- Is `AgentSchema` authored as `Schema.Struct`, `Schema.Struct.Fields`, or an
  agentOS wrapper that owns construction and projection?
- Which constructs fail before boot?
  - transforms;
  - filters/refinements without JSON Schema meaning;
  - recursive/lazy schemas;
  - class schemas;
  - defaults;
  - brands;
  - template literals;
  - unsupported unions.
- Are title/description/examples/default semantic for fingerprinting, provider
  projection, both, or neither?
- Does the canonical fingerprint projection stay stable across:
  - property order;
  - enum/required order;
  - module construction style;
  - Bun/Node/runtime execution;
  - Effect dependency patch/minor changes?
- Can OpenAI, Anthropic, Gemini, and AG-UI JSON Schema projections be generated
  from the same source without caller-supplied raw JSON Schema?
- Which provider-specific lossy changes are allowed as named projections?
- Which provider/package versions are part of the projection evidence and golden
  fixture names?

## Acceptance Criteria

- Supported object/string/number/boolean/array/literal-enum/union fixtures
  decode, fingerprint, and provider-project from one source.
- Equivalent schemas have identical fingerprints.
- Semantic changes change fingerprints.
- Annotation-only changes follow an explicit policy and have tests.
- Provider-specific JSON differences do not change schema fingerprints.
- Unsupported Effect Schema features fail before route/tool/admission boot.
- No adapter calls `JSONSchema.make` directly; only `AgentSchema` projection APIs
  may do so.
- Raw tool/admission schema constructors fail at typecheck and boot.

## Verification

```sh
bun run test -- AgentSchema
bun run typecheck
```

Additional hard gates to add once the module exists:

```sh
! git grep -E "JSONSchema\\.make" -- packages | grep -v "agent-schema"
! git grep -E "ToolDefinition.*parameters: object|outputSchema\\?: JsonSchemaObject|SchemaContract.*schema: JsonSchemaObject" -- packages
```

## Output

The spike must produce:

- an `AgentSchema` fixture matrix;
- a supported/unsupported feature table;
- the fingerprint algorithm decision;
- provider projection snapshots;
- the raw JSON Schema deletion scope for a86/a89.
