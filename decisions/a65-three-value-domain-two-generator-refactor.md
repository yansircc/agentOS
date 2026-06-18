# a65: Three Value Domains And Two Generators

## Situation

agentOS has converged on strong durable-truth and boundary machinery, but the
same projection shape appears in several places: documentation generation,
runtime read models, wire envelopes, and the planned authoring compiler. The
runtime also relies on repeated prose constraints to keep pre-runtime intent,
ledger-safe runtime facts, and live provider material apart.

That repeated boundary is the signal. The repo already says, in several forms,
that resolved provider material, continuation payloads, snapshots, raw file
bytes, and provider handles must not enter claims, ledger events, projections,
stream frames, error payloads, or docs examples. A rule that must be repeated at
every boundary is not strong enough as review discipline.

The eve review supplied external pressure evidence for the same boundary. Its
file-convention authoring model is useful, but its authored/runtime/live split
is enforced mostly by convention and local constructors. The reviewed leak
examples were:

- `CompiledScheduleDefinition.hasRun` persists authored handler presence under
  a runtime-sounding dispatch boolean in compiled output.
- Durable session state is structurally open enough to accept non-durable live
  values unless every writer stays disciplined.
- Tool output redaction can depend on documentation or per-tool convention
  rather than a type-owned live-to-recorded constructor.
- Dynamic tool resolver failures can warn and skip, making the runtime-visible
  tool set non-reproducible.

agentOS should not copy eve's convention layer as-is. The valuable lesson is the
opposite: the boundary is real, so it should be made structurally
unrepresentable to cross it accidentally.

Current audit status: the first migration step is intentionally diagnostic. It
will add `audit:value-domains` as a suspect map, not a positive contract gate,
and it must not create a tracked leak baseline or allowlist. Source ownership
must come from types, constructors, schemas, parsers, and module boundaries.

## Options

Option 1: add an app-authoring layer above the existing substrate.

This improves first-run ergonomics but leaves the deeper duplicate generator
problem intact. It risks making authoring another projection pipe beside docs,
runtime read models, and wire adapters.

Option 2: keep the current boundary as review discipline.

This is the lowest immediate change, but the eve evidence shows that convention
alone leaks at exactly the authored/runtime/live boundary agentOS also cares
about. It also keeps app authors close to `SubmitSpec`, `defineAgentDO`,
material lowering, and runtime wiring.

Option 3: refactor around three value domains, two generators, and one L0
predicate family.

This makes the boundary explicit, puts every generator into one of two classes,
and lets authoring become a projection instance instead of a new mechanism.
This is the selected option.

## Decision

agentOS will converge on three value domains:

- `Authored<T>` is pre-runtime intent. Its largest resident is
  `AgentManifest`. It may enter authored trees and compiled manifests.
- `Recorded<T>` is ledger-safe runtime fact. Its largest residents are ledger
  events and projection inputs.
- `Live<T>` is adapter-local live material: credentials, endpoint clients,
  sandbox handles, raw file bytes, opaque callback tokens, or unrebuildable
  provider payloads. It must not be serialized or stored in manifests, ledgers,
  projections, streams, docs, or error payloads.

Brand constructors are closed. Values read from external input, storage, or the
network start as unknown values and must pass a schema, parser, codec, or
boundary checker before receiving an `Authored` or `Recorded` brand. A TypeScript
brand alone is not a runtime acceptance proof.

agentOS will recognize exactly two generators:

- `Projection` is a total `source -> view` derivation. It is fail-closed and
  carries provenance. Documentation pages, runtime read models, safe browser
  event views, AG-UI envelopes, telemetry mappings, and the future authoring
  compiler are projection instances.
- `Driver` is the only imperative truth-advancing generator. It consumes
  `Recorded` truth plus input or effects and appends `Recorded` truth. Submit,
  ReAct/tool execution, settlement, timeout, resume, compaction, rekey, and
  provider calls belong here.

There is no third generator. A backend mount may interpret an
`AgentManifest<Authored>` only into driver configuration plus projection sinks.
It must not smuggle backend-specific truth logic into a third execution class.

The L0 layer is a predicate family over value-domain edges and existing
`BoundaryContract` axes. It has two interpreters rather than one hard-wired
function: compile-time checks over manifests and runtime checks over ledger
transitions. Constraints never supply values. Defaults are versioned value
layers with origin; constraints only accept or reject.

The legal value-domain edges are:

- `Authored` may compile or mount into driver configuration and projection sink
  configuration.
- `Live` may become `Recorded` only through an owner parser, redactor, receipt,
  digest, symbolic ref, or codec that emits ledger-safe facts.
- `Recorded` may feed `Projection` to derive views.

The forbidden edges are:

- `Live -> Authored`
- `Live -> any serialized position`
- `Recorded -> Live` without re-running an adapter-owned resolver
- direct `Authored -> Recorded` truth commits
- duplicate authored fact keys

`SafeLedgerPayload` remains a browser-safe projection payload, not the base type
for `Recorded` ledger facts. Recorded payload vocabulary needs its own
source-owned home.

The fourth value-domain candidate is rejected for now. Durable private state
should first be modeled as `Recorded<Sealed>` plus an AEAD codec family. That is
valid only when the encryption key is `Live`, ciphertext includes codec
identity, version, nonce, AAD, and key reference metadata, and `open` is
reachable only inside adapter or driver modules. If ciphertext becomes a
persistent way to smuggle live semantics through ordinary code, the design has
failed.

`InputRequest` becomes a runtime-owned primitive, not an authoring feature. It
unifies approval, question, and authorization flows as:

```text
request -> park -> keyed resume
```

The ledger may record request metadata, principal, kind, display/challenge
metadata, and symbolic references. Callback tokens and authorization secrets
are `Live` or `Recorded<Sealed>` and must not appear as plaintext ledger facts.
`ContinuationRef` remains a ledger-witnessed `Recorded` symbol, not a naked
capability token.

Compaction and rekey are driver actions that append facts. They must not mutate
or replace prior history. A visible history is a projection over ledger facts and
checkpoint facts.

`MaterialRef broker` capability becomes part of execution-domain contracts.
When an execution domain supports trusted outbound substitution, untrusted code
may receive a placeholder while the owner driver substitutes live bytes at the
final outbound boundary. When a domain does not support trusted substitution,
the live value must stay on the owner stack and the operation must fail closed
instead of treating the placeholder as a normal string.

The target topology is five buckets:

- `axioms`: value domains, refs, `BoundaryContract`, and L0 predicates.
- `ledger`: append-only truth, driver, settlement state machine, and
  ledger-witnessed continuation refs.
- `projection`: one projection engine, provenance, and sink runner.
- `adapters`: backend, provider, transport, sandbox, workspace, broker, and
  codec implementations. Physical packages may stay split by provider or
  runtime environment.
- `authoring`: authored tree syntax and defaults. It is a projection instance,
  not a third generator.

The migration order is:

1. Land this ADR, value-domain brands, suspect-only audit, live-edge import
   guard, and the web-cursor kernel-import ratchet.
2. Extract one projection engine and migrate docs plus pure runtime projectors.
3. Demote composers and wire adapters into projection sinks.
4. Implement runtime-owned `InputRequest`.
5. Peel submit, ReAct, settlement, timeout, resume, compaction, and rekey into
   an explicit driver with closed `NextDriverAction` arms.
6. Unify adapters around live resolution, capture, dispose, AEAD sealing, and
   material brokering.
7. Retrofit existing packages to `Authored`, `Recorded`, and `Live` domains.
8. Build the authoring tree compiler to normalized `AgentManifest<Authored>`.
9. Delete or demote the public app facade, rewrite app-author docs, and prove
   the web-cursor spike reaches zero app-author imports from `@agent-os/kernel`.

The eve mechanisms worth borrowing as implementation patterns are:

- protocol-as-single-contract, where client and server projections share the
  same protocol module.
- `AgentManifestProjection`, a pure manifest-to-info view for HTTP, CLI, docs,
  and generated clients.
- guard ratchets that only shrink once a positive source-owned contract exists.

The rejected negative examples are:

- injecting a missing model default without an owning versioned default layer
  and origin.
- schema `.default(...)` values that erase provenance.
- implicit host execution domains for effectful tools.
- dynamic resolver warn-and-skip behavior.
- mutating history for compaction.
- treating naked tokens as capabilities.
- one global stream version for unrelated additive and breaking changes.

## Kill Criterion

Kill or redesign this refactor if the Step 1 audit plus source-owned brand work
shows that the three value domains cannot cover the existing public surface and
the forced fourth class cannot be represented as `Recorded<Sealed>` with a
closed codec.

Kill or redesign it if the web-cursor workspace spike cannot reach zero
app-author imports from `@agent-os/kernel` without introducing hidden defaults,
second facts, compatibility shims, or injection.

Kill or redesign it if any of these required closures fails:

- sealed ciphertext becomes persistent pseudo-live state available to ordinary
  code.
- `InputRequest` leaks callback tokens, authorization secrets, or resume
  payloads into ledger facts.
- `MaterialRef broker` support degrades into passing placeholders as ordinary
  strings.
- backends grow a third generator instead of producing driver configuration and
  projection sinks from manifests.

## Revisit

Revisit an independent durable-private value domain only if a backend must reuse
opaque state across steps or redeploys, has no upstream store, and cannot model
the state as `Recorded<Sealed>` without exposing live semantics.

Revisit `parked` as a sixth `BoundaryContract` axis only after multiple
carriers need non-terminal settlement as an independent contract. Until then,
runtime-owned `InputRequest` and ledger-witnessed continuation refs carry the
state.

Revisit stream versioning when runtime events split into independently
versioned additive and breaking vocabularies. A single global stream version is
not acceptable once unrelated event families evolve at different rates.

Revisit root check integration for value-domain scanning only after positive
contracts exist: source-owned brands, closed constructors, parser or schema
entry points, import-boundary guards, and type-level negative tests. Until then,
`audit:value-domains` remains a suspect-only diagnostic.
