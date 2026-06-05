# AgentSchema

## Problem

Tool arguments and structured LLM output used to cross three schema sources:
tool authors supplied JSON Schema, provider adapters normalized provider JSON
Schema, and runtime admission computed fingerprints from the provider-shaped
object. That made the same algebra appear in multiple forms and forced
consumers to guess whether a JSON Schema object was the source fact or a wire
projection.

## Model

`AgentSchema` is the single schema source for tool arguments and structured
admission output. Authors provide an Effect Schema value or an already wrapped
`AgentSchema`; agentOS validates it against the supported AgentSchema profile at
boot, derives the closed JSON Schema projection, computes the schema
fingerprint, and exposes provider-specific projections for OpenAI, Anthropic,
Gemini, and AG-UI.

The supported profile is intentionally smaller than Effect Schema. It accepts
object-root schemas built from stable object, string, number, boolean, array,
string literal, and union forms that can project losslessly to provider JSON
Schema and decode runtime values with the same source. Defaults, transforms,
brands, refinements, raw JSON Schema annotations, recursive schemas, index
signatures, nullable literals, and other lossy constructs fail fast with
`AgentSchemaProfileError`.

Provider JSON Schema is a derived fact. Admission fingerprints are derived from
the canonical AgentSchema JSON projection, not from provider-normalized wire
objects. AG-UI tool schemas use the AG-UI projection from the same AgentSchema
source. Runtime validation remains valid at unknown JSON/protocol boundaries,
but internally constructed tool/admission schemas must not be reconstructed
from JSON Schema.

The raw JSON Schema dialect remains only for non-LLM boundary and carrier
contracts that already use JSON Schema as their independent payload dialect.
That dialect is named `json-schema-dialect` to keep it separate from
tool/admission schema ownership.

## Non-Goals

This concept does not move runtime orchestration to Effect AI, define provider
transport output item ADTs, or choose a workspace file projection schema. It also
does not make arbitrary Effect Schema features provider-compatible.

## Related

- [Usage surfaces](../usage-surfaces.md)
- [Tool execution domain](tool-execution-domain.md)
- [Durable truth](durable-truth.md)
