# Spec 28: img-gen gap implementation plan

> **Status**: Implementation roadmap (drafted 2026-05-26)
> **Depends on**: [spec-26-img-gen-substrate-survey.md](./spec-26-img-gen-substrate-survey.md)
> **Does not implement**: img-gen product behavior. This document only orders
> confirmed substrate gaps and defines the minimal acceptance surface for each.

---

## 0. Planning invariant

> **Every shipped primitive must remove one confirmed forge from spec-26 by
> construction. A primitive is rejected if it only shortens app code, hides
> direct RPC, or creates a second source of truth next to `events`.**

Stable axis:
- `events` remains the ledger SSoT.
- pending buffers may exist only as delivery/scheduling mechanics, same class
  as `scheduled_events`: not business truth, always linked to ledger events.
- cross-scope recipients are `AgentDOBase` scopes only. Non-DO receivers are
  carriers under INV-9 and are out of scope.

Change axis:
- add the minimum substrate primitives needed by C1/C2, C3, and C5.
- keep C4 as an explicit no-op unless a future app falsifies it.

---

## 1. Dependency order

| Phase | Gap | Ship? | Why this order |
|---|---|---:|---|
| P1 | C1/C2 cross-DO durable delivery | yes | It is the control-flow generator. C3 settlement and image job fanout both become cleaner once cross-ledger delivery exists. |
| P2 | C3 resource reservation/release | yes | It depends on ledger projection discipline but not on image route. Can dogfood C1 by moving reservation across user/session scopes. |
| P3 | C5 image-output route | yes | It extends protocol capability algebra after route/admission work is stable. It should not be blocked by resource ledger design. |
| P4 | C4 R2 blob carrier | no | spec-26 proved it fits INV-9: bytes in R2, refs in ledger. No substrate primitive now. |

Do not start P2 or P3 by patching spike-07 workarounds. Each phase first
defines the algebra, then implements core, then removes the corresponding
`GAP-Cn` marker from the spike.

---

## 2. P1 — C1/C2 cross-DO durable delivery

### 2.1 Generator

Current app forge:
- sender scope writes a fact, then directly calls another DO via namespace RPC.
- if the call fails after the sender fact commits, delivery truth is outside
  the ledger.
- img-gen solves this with `queue_outbox`; spike-07 exposes the same forge via
  direct `emitEvent` RPC.

Substrate primitive:

```ts
class AgentDOBase {
  dispatchToScope(spec: {
    target: { bindingRef: string; scope: string };
    event: string;
    data: unknown;
    idempotencyKey: string;
  }): Promise<{ outboundEventId: number }>;
}
```

App hook:

```ts
protected provideDispatchTargets(): Record<string, DurableObjectNamespace>;
```

`bindingRef` is symbolic, like `endpointRef` / `credentialRef`. The ledger
stores the ref, not a runtime namespace object.

### 2.2 SSoT placement

Sender ledger events:
- `dispatch.outbound.requested`
- `dispatch.outbound.delivered`
- `dispatch.outbound.failed`

Receiver ledger events, written in one transaction:
- `dispatch.inbound.accepted` with dispatch metadata:
  `{ sourceScope, outboundEventId, idempotencyKey, deliveredEventId }`
- the requested app event with payload unchanged.

The app event's payload must not be wrapped or augmented. Dispatch metadata is
substrate bookkeeping, not app fact shape.

Pending buffer:
- internal `dispatch_outbox` table, keyed by `outboundEventId`.
- it is not SSoT; it is a delivery buffer derived from
  `dispatch.outbound.requested`, same category as `scheduled_events`.

Receiver idempotency:
- receiver must ignore duplicate `(sourceScope, outboundEventId)` attempts by
  reading `dispatch.inbound.accepted`.
- duplicate delivery returns the existing `deliveredEventId` and does not fire
  handlers twice.

### 2.3 Minimal implementation boundary

Core files expected:
- `packages/core/src/dispatch.ts` for service/algebra.
- `packages/core/src/agent-do.ts` for public method and receiver RPC.
- `packages/core/src/event-bus.ts` untouched except normal fire path.
- `packages/core/test/dispatch-contract.test.ts`.

No dependency on Cloudflare Queues in v0. The first implementation can drain
the sender outbox synchronously after commit and via alarm retry. Queue-backed
delivery can be an implementation replacement later without changing the
public primitive.

### 2.4 Acceptance

Contract tests:
- sender write and outbox insert are atomic.
- receiver writes exactly one app event for repeated delivery attempts.
- receiver preserves app payload exactly; dispatch metadata lives only in
  `dispatch.inbound.accepted`.
- receiver `on()` fires after commit.
- missing `bindingRef` is a config error, not silent fallback.
- reserved event kinds cannot be dispatched.
- failed first delivery leaves retryable sender state.

Spike update:
- replace spike-07 direct session -> user, user -> session, session ->
  consumer, consumer -> session RPC with `dispatchToScope`.
- remove C1/C2 markers from `worker.ts`.
- keep `GAPS.md` history, but mark C1/C2 resolved by P1 commit.

Done means direct cross-ledger RPC is no longer required by any app to express
durable delivery between `AgentDOBase` scopes.

---

## 3. P2 — C3 resource reservation/release

### 3.1 Generator

Current app forge:
- `withQuota` grants consumption for a carrier/tool dispatch.
- img-gen needs business resource state: grant credits, reserve credits, later
  consume or release the reservation.
- mutable account/reservation tables become a second SSoT unless the substrate
  owns the projection.

Do not overload `Quota`. Quota is dispatch consumption/rate limiting.
Resource reservation is a different state machine over ledger facts.

Substrate service:

```ts
class Resources {
  grant(spec: {
    key: string;
    amount: number;
    ref: string;
  }): Effect.Effect<{ eventId: number }, ResourceError, Ledger>;

  reserve(spec: {
    key: string;
    amount: number;
    ref: string;
    idempotencyKey: string;
  }): Effect.Effect<{ reservationId: string }, ResourceError, Ledger>;

  consume(spec: {
    reservationId: string;
    ref: string;
  }): Effect.Effect<void, ResourceError, Ledger>;

  release(spec: {
    reservationId: string;
    ref: string;
  }): Effect.Effect<void, ResourceError, Ledger>;
}
```

Public `AgentDOBase` methods may wrap this service after the algebra is stable.

### 3.2 SSoT placement

Ledger events:
- `resource.granted`
- `resource.reserved`
- `resource.consumed`
- `resource.released`
- `resource.reserve_rejected`

Projection:
- available = grants - active reservations - consumed
- reserved = active reservations
- consumed = consumed reservations

No `resource_accounts` table in core. Any read helper is a projection over
events.

### 3.3 Minimal implementation boundary

Core files expected:
- `packages/core/src/resources.ts`.
- `packages/core/src/agent-do.ts` only if public Promise methods are added.
- `packages/core/test/resource-contract.test.ts`.

P1 dependency:
- if resource reservation lives in a user scope and request lives in a session
  scope, the app uses `dispatchToScope` to ask the user scope to reserve.

### 3.4 Acceptance

Contract tests:
- reserve succeeds when projected available balance is sufficient.
- reserve rejects without writing `resource.reserved` when insufficient.
- same `idempotencyKey` returns same reservation.
- consume and release are mutually exclusive.
- duplicate consume/release is idempotent or explicitly rejected by class.
- projection reconstructs balance from events only.

Spike update:
- replace spike-07 hand-rolled `credit.reserved` / `credit.consumed` protocol
  with `Resources`.
- remove C3 markers from `worker.ts`.

Done means apps no longer need mutable account/reservation tables to express
reserve-now, consume-or-release-later resources.

---

## 4. P3 — C5 image-output route

### 4.1 Generator

Current app forge:
- provider route selection and credential resolution live in app code.
- response decoding from provider envelope to bytes is app-owned.
- model capability is a table/config decision, not evidence/protocol algebra.

This is the same generator as spec-27, but not the same interface:
`LlmProtocolAdapter` owns text turns and structured tool-call admission.
Image generation has no turn loop. Do not force it into `decodeTurn`.

Route taxonomy:

```ts
type AiRoute =
  | { family: "llm"; route: LlmRoute }
  | { family: "image"; route: ImageRoute };

type ImageRoute =
  | { kind: "openai-images-compatible"; endpointRef: string; credentialRef: string; modelId: string }
  | { kind: "cf-ai-binding-image"; modelId: string; gatewayRef?: string };
```

Adapter algebra:

```ts
interface ImageProtocolAdapter<K extends ImageRoute["kind"]> {
  readonly kind: K;
  readonly version: string;
  encodeImage(route: Extract<ImageRoute, { kind: K }>, request: ImageRequest): ProviderRequestBodyFor<K>;
  decodeImage(raw: unknown): ImageResult;
  classify(error: unknown): Outcome;
}

type ImageResult = {
  bytes: Uint8Array;
  contentType: string;
  usage?: { units?: number; tokens?: number };
};
```

Core returns bytes and metadata. R2 storage remains app/carrier-owned unless a
future spike proves otherwise.

### 4.2 Evidence boundary

v0 does not need a lease table. It needs route/protocol ownership:
- finite image protocol adapters.
- symbolic endpoint/credential refs via `ProviderRegistry`.
- no model whitelist in app code.

If image providers show schema/capability flake similar to structured output,
add `image.generate.evidence` as a later admission-style subsystem. Do not
pre-build it without a falsifying spike.

### 4.3 Minimal implementation boundary

Core files expected:
- `packages/core/src/image.ts`.
- possible `packages/core/src/ai-route.ts` if `AiRoute` umbrella becomes useful.
- `packages/core/test/image-adapter-contract.test.ts`.

Do not rename `LlmRoute` repo-wide unless the implementation actually needs
the umbrella type at public boundaries. A narrow additive `ImageRoute` is the
first move.

### 4.4 Acceptance

Contract tests:
- openai-images-compatible transport uses endpoint + credential refs.
- cf-ai-binding-image uses `env.AI.run`, not fetch.
- invalid credentials classify as `AuthError`.
- provider binary/base64 JSON response decodes to `ImageResult`.
- no route stores raw credential in ledger or result.

Spike update:
- replace spike-07 `fakeImageProvider` with `generateImage`.
- keep R2 put in the app.
- remove C5 marker from `worker.ts`.

Done means apps no longer need provider-specific image route selection and
response parsing just to call an image model.

---

## 5. P4 — C4 R2 blob carrier

No substrate implementation.

Reason:
- spec-26 and spike-07 show the clean ownership shape: R2 stores bytes;
  ledger stores refs.
- key containment, retention, deletion policy, and public URL policy are app
  concerns unless repeated apps show the same invariant failure.

Allowed follow-up:
- add an optional docs note under spec-24 §11.1 showing R2 as an example
  carrier implementing state-root + cleanup discipline.

Rejected follow-up:
- `R2Carrier` in core now. That would add abstraction without removing a
  confirmed forge.

---

## 6. Commit sequence

Recommended commits:

1. `spec-28: dispatchToScope design`
   - spec update only.
   - resolves open questions: outbox table shape, receiver idempotency key,
     bindingRef registry.

2. `core: cross-scope dispatch primitive`
   - P1 implementation + contract tests.
   - spike-07 C1/C2 marker removal.

3. `spec-28: resource ledger design`
   - finalize Resource vs Quota separation.

4. `core: resource reservation ledger`
   - P2 implementation + contract tests.
   - spike-07 C3 marker removal.

5. `spec-28: image route adapter design`
   - finalize route names and first image protocols.

6. `core: image-output route adapter`
   - P3 implementation + contract tests.
   - spike-07 C5 marker removal.

7. `docs: record C4 no-op carrier boundary`
   - optional spec-24 note only, if useful.

---

## 7. Global verification gate

Every implementation phase must pass:

```bash
bun run typecheck
cd packages/core && bun run test
git diff --check
```

Each phase also needs a spike-07 smoke update. If the smoke uses a real
provider credential, the credential must live in `.dev.vars` and never enter
the ledger, docs, or test output.

---

## 8. Stop conditions

Stop and redesign if any implementation requires:
- a second durable truth table that is not a pending buffer derived from a
  ledger event,
- non-DO cross-scope recipients in `dispatchToScope`,
- route fallbacks between protocol kinds,
- app-owned capability tables for supported models,
- R2 byte storage inside the core ledger.

Those are invariant violations, not implementation details.
