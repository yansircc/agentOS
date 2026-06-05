# a88: Structured Admission on Effect AI

## Summary

stable axis: agentOS owns capability evidence, leases, barriers, route fingerprints, budget decisions, deliver events, and terminal run facts.  
change axis: provider call used to produce structured decode evidence.  
invariant: structured admission records evidence about provider capability; it never owns product delivery or terminal lifecycle.

This task depends on a86, a93, and a87. Admission consumes the normalized
provider output item ADT; it does not parse provider-native response JSON or
Effect AI response parts directly.

## Key Changes

- Rebuild structured admission on the same Effect Schema source used by tools.
- Use Effect AI `generateObject` or a forced-tool strategy only as a provider call mechanism.
- Preserve agentOS evidence ownership:
  - admission writes `llm.structured.evidence` and `llm.structured.invalidate`;
  - submit owns deliver, budget abort, and terminal run facts.
- Keep admission fingerprint source-owned by agentOS:
  - route fingerprint;
  - schema fingerprint;
  - strategy, with distinct keys for native structured output, forced-tool
    structured output, and any future provider mode;
  - adapter/provider version facts.
- Map Effect AI decode/provider errors into agentOS admission outcomes.
- Keep lease/order algebra in runtime. Effect AI must not own evidence ordering or barriers.
- Structured success returns decoded output, outcome, token usage, and lease metadata only.
- Evidence keys include the effective route fingerprint, schema fingerprint,
  structured strategy, provider output adapter version, and Effect AI adapter
  version.

## Tests

- Live attempt writes evidence only; no deliver and no terminal fact.
- Structured submit success writes evidence, deliver, and completed through submit-owned path.
- Over-token structured submit writes evidence plus exactly one `agent.aborted.budget_tokens`; no deliver; no completed; no open run.
- Schema/decode failure maps to the same admission outcome class as the old path.
- Provider auth/rate-limit/overload failures map to existing outcome/error taxonomy.
- Same-ms evidence/barrier ordering still uses `(ts, id)`.
- Timeout behavior from a64 remains unchanged.
- Route matrix proves the chosen strategy for OpenAI-compatible, Anthropic, and
  Gemini:
  - provider-native structured output uses its own strategy key;
  - forced-tool parity uses `generateText`, forced `_submit_structured`, and
    unresolved tool calls;
  - changing strategy/provider/adapter version rekeys evidence.
- Provider-native response shape changes fail in the provider output adapter
  fixtures before admission evidence can be written.

## Gates

Full root gates plus structured-admission parity tests for OpenAI-compatible, Anthropic, and Gemini where provider support exists.

## Assumptions

- Effect AI may choose provider-native structured output or tool emulation only
  through an explicit route strategy. agentOS records strategy, evidence, and
  provider/adapter version facts.
- No product delivery fact is written inside admission.
