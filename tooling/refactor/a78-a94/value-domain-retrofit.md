# Value Domain Retrofit

This file is the source owner for Phase 6 retrofit order and public-surface
invariants. CST review evidence may point here, but must not duplicate this
plan as a second table.

## Axes

```text
stable axis: authored intent, recorded truth, live material
change axis: package surfaces migrating from structural DTOs to value domains
invariant: a value can enter a domain only through the owner parser,
constructor, codec, or module boundary for that domain.
```

## Domain Meanings

- `Authored<T>` is pre-runtime intent. It may describe routes, tools, material
  refs, execution domains, manifests, and policy, but it never contains ledger
  facts, secrets, continuations, snapshots, actual trigger times, or resolved
  material.
- `Recorded<T>` is witnessed runtime truth. It is produced only by a parser,
  codec, commit constructor, or runtime driver boundary with positive evidence.
- `RecordedPayload` is the independent JSON-compatible payload vocabulary for
  recorded facts. It is not `SafeLedgerPayload`.
- `SafeLedgerPayload` is a browser-safe projection payload. It is a derived
  view for UI/API exposure and cannot be used as a recorded truth base type.
- `Live<T>` is resolved runtime material or capability. Construction, sealing,
  opening, and raw access are adapter/driver internals. Public APIs may expose
  `Live<T>` as an opaque type only when the caller cannot construct or open it.

## Public-Surface Invariants

1. Public serialized DTOs contain no `Live<T>` fields, raw resolved material,
   credentials, provider URLs, provider-native clients, file bytes, or secret
   values.
2. Any public deserialized value branded `Recorded<T>` has parser, schema,
   codec, or ledger-driver evidence at the owning boundary.
3. Authored APIs accept only pre-runtime intent. Runtime facts, `ContinuationRef`
   capabilities, snapshots, actual trigger times, and provider-resolved material
   are rejected instead of defaulted or copied into authored values.
4. Projection APIs consume recorded ledger facts and emit views. They cannot
   call providers, open `Live<T>`, mutate truth, or become source owners for
   serialized runtime facts.
5. Driver APIs append `Recorded<T>` truth. They can cross the live edge only
   through scoped adapter/driver internals, and any durable result must pass
   through recorded constructors or codecs.
6. Kernel root exports may expose `Authored<T>`, `Recorded<T>`, `RecordedPayload`,
   and opaque `Live<T>` types. They must not expose `captureLive`, `openLive`,
   AEAD open/seal helpers, or exported wrappers that call those helpers.
7. Duplicate suppliers for the same fact are build failures. If a field can be
   supplied by both an authored value and a runtime observation, the owning
   domain must be split before migration continues.

## Retrofit Order

### 1. `runtime-protocol`

Own the serialized boundary first.

Required changes:

- Brand runtime event payloads, replay artifacts, continuation-bearing refs,
  admission ledger rows, and ledger commit specs as `Recorded<T>` where they
  represent witnessed truth.
- Keep `SubmitRunInput`, route/tool bindings, execution-domain declarations,
  material refs, and tool policy in the authored domain.
- Keep `SubmitSpec` as the driver input boundary. It may contain authored
  declarations and runtime authority, but it must not be treated as a recorded
  fact until the driver commits events.
- Keep `SubmitResult` as a projection output reconstructed from recorded ledger
  facts. It can expose recorded symbolic refs such as `ContinuationRef`, but it
  is not itself a durable recorded fact.
- Define recorded payload vocabulary independently from browser-safe projection
  vocabulary. `safe-events.ts` may project to `SafeLedgerPayload`, but cannot
  supply `RecordedPayload`.
- Preserve `ContinuationRef` as a recorded symbolic ref derived from ledger
  interruption facts, not as a naked bearer token or authored value.
- Prefer constructor/decoder return branding before constructor input branding:
  runtime event constructors already centralize positive decode, while public
  callers still pass ordinary typed payload inputs.

Exit gate:

- Runtime event constructors/decoders are the only way public code obtains
  recorded runtime events.
- `SafeLedgerPayload` imports in this package are limited to safe projection
  code.
- `SubmitRunInput`, `SubmitSpec`, and `SubmitResult` are not bulk-branded as
  recorded truth.

### 2. `kernel`

Own source-domain algebra after the serialized runtime boundary exists.

Required changes:

- Mark boundary contracts, material refs/requirements, execution domains, tool
  declarations, tool definitions, agent schemas, and manifest-like declarations
  as authored surfaces.
- Mark settlement facts, validated boundary payloads, tool-call receipts,
  broker receipts, and diagnostic facts as recorded surfaces only after their
  owner parser or constructor has accepted them.
- Keep `Live<T>` construction/opening under internal live-edge modules and
  guarded public boundaries.
- Move any public raw-material tool context to an opaque live/lease boundary or
  make the raw edge adapter-private.

Exit gate:

- `check:boundaries` rejects public constructors, openers, sealers, and exported
  wrappers for live material.
- No kernel public surface uses `SafeLedgerPayload` as recorded truth.

### 3. `runtime`

Move the driver/projection split onto the typed domains.

Required changes:

- `NextDriverAction` carries only events that can be committed as recorded truth
  by the driver.
- Runtime loop code appends through driver actions rather than constructing
  ledger-visible object literals at arbitrary call sites.
- Projection code reads recorded ledger events and derives view models only.
- Internal driver input no longer extends the public `SubmitSpec` shape without
  naming the authored, bound, recorded-ref, and live-edge fields it carries.
- InputRequest park/resume wiring is absorbed into the driver `park` arm; no
  second park/resume path is introduced.
- Runtime L0 predicates use the same predicate family as compile-time
  authoring constraints, interpreted over ledger transitions instead of
  manifests.

Exit gate:

- Driver code is the only runtime writer of recorded runtime truth.
- Projection modules have no provider calls, no live openers, and no ledger
  mutation.

### 4. Wire Adapters, Composers, And Backends

Move edge surfaces after the core domains are typed.

Required changes:

- Run-stream, turn-stream, attached-stream, AG-UI, and other composers consume
  recorded runtime facts or typed projections and emit views only.
- Run-stream treats `submit_result` as a projection terminal frame, not recorded
  truth.
- AG-UI lowering may convert external client input plus framework defaults into
  authored submit input, but it cannot inject runtime facts, resolved material,
  or continuation capability values into authored state.
- Safe event projection fields must come from owner contracts or be omitted.
  Heuristics may remain only as diagnostics after a positive projection
  contract has already accepted the value.
- Cloudflare DO and future backends mount a manifest into exactly one driver
  plus projection sinks. They do not invent backend-local runtime truth.
- Backend material resolution converts symbolic refs to live material only at
  adapter/driver edges and disposes scoped leases.
- Product-facing APIs expose redacted projections, not raw ledger payload
  pass-through.

Exit gate:

- Public wire DTOs contain no `Live<T>`.
- Any deserialized recorded input has parser evidence.
- Backend code cannot bypass runtime-protocol constructors for runtime facts.

### 5. Phase Review

Run after the package migrations.

Required checks:

- Public serialized DTOs contain no `Live<T>`.
- Every deserialized recorded brand has parser, schema, codec, or driver
  evidence.
- `SafeLedgerPayload` remains projection-only.
- `audit:value-domains` may be used as a suspect scan, but it is not promoted to
  a root gate until each suspect class has a source-owned positive contract.

## Mechanical Ratchets

- The web-cursor app-author import count for `@agent-os/kernel` is monotonic
  non-increasing from Phase 0 and must be zero after authoring lands.
- `effect-skill-scan <worktree> --strict --json --profile` is a normal close-out
  gate again. It is still a mechanical Effect/code-shape gate, not proof of
  domain semantics.
- `check:boundaries` remains the live-edge public-surface gate.
- `audit:value-domains` remains diagnostic until a later task attaches every
  finding class to a positive owner contract.
