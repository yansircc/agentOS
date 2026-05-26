# Spec 32: Image Package Boundary

> **Status**: superseded by [spec-34-authorized-commit-calculus.md](./spec-34-authorized-commit-calculus.md)
> **Date**: 2026-05-26

## 0. Revision

v0.3 removes image modality from `@agent-os/core`.

Deleted from core:

- `AgentDOBase.generateImage`
- root barrel re-exports of `ImageRoute`, `ImageRequest`,
  `GenerateImageSpec`, `ImageArtifact`, and `ImageResult`
- `@agent-os/core -> @agent-os/image` dependency
- `image.` as a core-reserved prefix
- image-provider registry bridging through core

## 1. Current Boundary

`@agent-os/core` owns only the general substrate mechanisms:

- authorized commit calculus
- ledger and projections
- dispatch idempotency
- resource reservation lifecycle
- quota middleware
- extension capability registration

`@agent-os/image` may own image workflow algebra, image protocol routes,
artifact normalization, and image-specific package events.

If `@agent-os/image` writes ledger facts under `image.*`, it must register an
extension package:

```ts
{
  packageId: "@agent-os/image",
  kindPrefixes: ["image."],
  version: "<package-version>"
}
```

That registration makes `image.*` extension-owned for that DO class, so
app-facing `emitEvent`, `submit.deliver.event`, `scheduleEvent`, and
`dispatchToScope.event` reject `image.*` with `CapabilityRejected`.

## 2. Non-Reservation Rule

Core does not reserve modality namespaces by name. `image.`, `audio.`,
`video.`, `web.`, and similar prefixes are not kernel vocabulary.

If a package needs a namespace, it registers that namespace through the
spec-34 extension protocol. If no package registers a prefix, core does not
special-case it.

## 3. Remaining Image Package Rules

The older idempotency and artifact-storage constraints still apply to the
image package:

- package-local dedup tables are rejected; use dispatch/resource truth or
  define a new general core primitive;
- artifact storage should be stream-first;
- provider-specific SDK or OAuth lifecycle belongs in a provider package, not
  in core.
