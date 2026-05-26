# Spec 32: Image Package Boundary

> Status: Draft v0
> Date: 2026-05-26

## 0. Invariant

`@agent-os/image` owns image workflow algebra. `@agent-os/core` still owns
ledger truth, reserved-event enforcement, dispatch idempotency, resource
reservation state, and the app-facing `AgentDOBase.generateImage` Promise
surface.

Stable axis:
- `events` remains the only ledger truth.
- app code cannot write `image.*` events through public core write methods.
- blob bytes live in carriers; ledgers store refs only.
- resource reservation dedup and settlement truth stay in core scopes.

Change axis:
- image protocol route adapters and pure image helpers move out of core.
- Cloudflare-only runtime pieces may later split from `@agent-os/image` when
  they become more than one adapter.

## 1. Reserved Prefix

`image.` is a core-reserved event prefix.

Reason: image job vocabulary is substrate-owned. If apps can call
`emitEvent("image.job.completed")`, image job projections become forgeable by
construction.

Only privileged substrate/package code may write `image.*` facts. v0 publishes
the vocabulary and projectors but does not add a public image-job writer.

## 2. Package Direction

Dependency direction is:

```text
@agent-os/core -> @agent-os/image
```

`AgentDOBase.generateImage` remains in core as a thin wrapper. Apps that only
use core do not assemble Effect layers or import image services.

Rejected for v0:
- `@agent-os/image -> @agent-os/core`: creates a package cycle or forces core
  services into image.
- fully decoupled service assembly in apps: violates the current app-facing
  invariant that core hides Effect runtime wiring.

## 2.1 Effect-Typed Surface

`generateImageEffect`, `ImageAiBinding`, `ImageProviderRegistry`, and
`Image*Error` are substrate-internal Effect-typed surfaces.

Apps must use `AgentDOBase.generateImage`. The core wrapper maps image package
errors back into the core Promise taxonomy:
- `ImageUpstreamFailure` -> `UpstreamFailure`
- `ImageEndpointNotFound` -> `EndpointNotFound`
- `ImageCredentialNotFound` -> `CredentialNotFound`

Direct app assembly of `generateImageEffect` is not a supported boundary in v0.
Doing so exposes package-local service tags and package-local error classes
that core deliberately hides.

## 3. v0 Surface

`@agent-os/image` owns:
- `ImageRoute`, `ImageRequest`, `GenerateImageSpec`
- `ImageArtifact`, `ImageResult`
- finite image protocol adapters
- `generateImageEffect`
- `IMAGE_EVENTS`
- pure `projectImageJobs`
- `imageJobIdempotencyKey`
- `withImageResourceSettlement`

`@agent-os/core` owns:
- `CORE_RESERVED_PREFIXES`, including `image.`
- `AgentDOBase.generateImage`
- provider registry source data via `provideRegistry()`
- resource reservation truth and dispatch idempotency truth

## 4. Idempotency

`@agent-os/image` may build canonical idempotency keys. It must not own a dedup
table.

v0 image job dedup uses existing core mechanisms:
- cross-scope jobs use `dispatchToScope` receiver dedup
  `(sourceScope, idempotencyKey)`.
- same-scope apps must choose an existing core write path or wait for a future
  generic core idempotency primitive.

A package-local `image_jobs` or `image_idempotency_keys` table is rejected
because it creates a second truth next to core dispatch/resource state.

## 5. Artifact Storage

`ArtifactStore` is intentionally not public in v0.

If it ships later, the input must be stream-first:

```ts
type ArtifactSource =
  | { kind: "url"; url: string }
  | {
      kind: "stream";
      body: ReadableStream<Uint8Array>;
      contentType: string;
    }
  | { kind: "data-url"; dataUrl: string };
```

Reason: in Workers, fetching a provider URL into bytes before R2 `put` buffers
the whole image in memory. The carrier implementation must be able to stream
from `fetch(url).body` into storage.

The interface waits for a second real store implementation or a repeated app
failure. One R2 implementation is not enough evidence to freeze a package
contract.

## 6. Cloudflare Split Condition

v0 keeps `cf-ai-binding-image` in `@agent-os/image` as a migration exception.
This is not the long-term package boundary.

Open `@agent-os/image-cloudflare` when either condition is true:
- a second Cloudflare-only capability enters the image package, such as an R2
  store, Workers-only Layer, or AI Gateway policy surface;
- importing or testing `@agent-os/image` requires a Workers runtime.

Until then, moving core image code once is cheaper and less error-prone than
opening another package for a single adapter.

## 7. Recraft Rule

Recraft can enter `@agent-os/image` only if it satisfies all three:
- fetch + Effect services are sufficient;
- credential handling is the same endpoint/credential-ref model;
- response artifacts normalize to `data-url | url | bytes`.

If it requires SDK-only clients, OAuth/signature flow, provider-specific
artifact lifecycle, or extra runtime dependencies, it must live in
`@agent-os/image-recraft`.
