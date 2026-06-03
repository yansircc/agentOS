# a64: Boundary Primitive Candidacy

## Situation

The web cursor spike exposed repeated friction at substrate-to-world
boundaries: provider calls, Durable Object RPC payloads, material resolution,
and deterministic tool execution. The common smell is an implicit boundary, but
the concrete boundary shapes may not be the same.

## Options

- Add a general `defineBoundary()` primitive now.
- Fix each boundary independently and never revisit the generator.
- Harden the LLM provider boundary first and record the second-boundary trigger
  for a future primitive decision.

## Decision

a64 hardens the LLM provider boundary without adding `defineBoundary()`.

The candidate second boundary is Durable Object RPC inbound payloads. The
trigger is a future spike repeating the need to declare inbound schema,
serialization rules, safety policy, and adaptation locus for DO RPC payloads.

When that trigger fires, compare the DO RPC boundary against the a64 LLM
provider boundary on four fields:

- direction and shape
- policy
- discoverability
- adaptation locus

If the fields are the same shape, propose `defineBoundary()` as a substrate
primitive. If they differ, keep concrete boundary hardening and update this
candidacy record.

## Kill Criterion

If the second boundary cannot use the four-field comparison without
boundary-specific exceptions, do not create `defineBoundary()` from a64
evidence.

## Revisit

Revisit when a DO RPC payload needs explicit schema, serialization, safety
policy, and adaptation locus, or when another non-LLM boundary repeats the same
four-field shape.
