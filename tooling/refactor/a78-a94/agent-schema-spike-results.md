# AgentSchema Profile Spike Results

## Invariant

stable axis: agentOS owns schema authority, decode semantics, fingerprints, and
provider projection boundaries.  
change axis: the allowed Effect Schema feature subset and projection
algorithms.  
invariant: one `AgentSchema` source derives runtime decode, canonical
fingerprint, provider JSON Schema, AG-UI JSON Schema, and later Effect AI tool
schemas.

## Fixture Matrix

Supported inside a root `Schema.Struct`:

| Feature             | Decision                                           |
| ------------------- | -------------------------------------------------- |
| object              | supported as the root and nested object shape      |
| string              | supported                                          |
| number              | supported                                          |
| boolean             | supported                                          |
| array               | supported for homogeneous arrays                   |
| string literal enum | supported through `Schema.Literal("a", "b")`       |
| union               | supported when every member is also in the profile |

Rejected before boot:

| Feature                   | Reason                                                       |
| ------------------------- | ------------------------------------------------------------ |
| transforms                | decode semantics differ from provider JSON Schema            |
| filters/refinements       | JSON Schema projection may be lossy or provider-specific     |
| recursive/lazy schemas    | require identity/reference policy not in a86a                |
| class/declaration schemas | carry construction/runtime semantics outside provider schema |
| defaults                  | mutate decode semantics and evidence shape                   |
| brands                    | type-only proof has no provider JSON Schema meaning          |
| template literals         | regex projection and provider support need a separate policy |
| non-string literal enums  | current closed dialect supports string enums only            |
| root non-object schemas   | tools/admission accept object-shaped arguments/output        |

## Fingerprint Algorithm

The spike uses `agent-schema-v1:sha256:<hex>` over canonical closed JSON Schema:

- object keys are sorted recursively;
- set-semantics arrays such as `required` and `enum` are sorted;
- annotations (`title`, `description`, `examples`, `default`, `$comment`,
  `x-*`) are stripped before hashing.

Annotation-only changes are non-semantic for fingerprints. They also do not
enter the current canonical provider/AG-UI projections. A later UI metadata
task may add a separate metadata projection, but it must not change schema
identity.

## Provider Projections

The single source projects to:

- canonical closed JSON Schema;
- OpenAI tool/function parameters;
- Anthropic `input_schema`;
- AG-UI tool JSON Schema;
- Gemini JSON Schema with known unsupported transport fields stripped.

Provider-specific lossy projection does not change the canonical fingerprint.
Gemini stripping is wire translation only; local decode still uses the canonical
closed schema.

## Raw JSON Schema Deletion Scope

a86/a89 should delete raw JSON Schema as a source for tool and structured
admission authoring. Non-LLM substrate schemas such as carrier payload schemas
and boundary contracts remain on the existing closed JSON Schema dialect until a
separate source-owner task decides their migration.

## Evidence

- `packages/kernel/src/agent-schema.ts`
- `packages/kernel/test/agent-schema.test.ts`
- `bun run --cwd packages/kernel test agent-schema.test.ts`
