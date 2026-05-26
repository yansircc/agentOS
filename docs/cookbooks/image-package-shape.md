# Image Package Shape

## Invariant

Image algebra is package-owned; ledger and runtime enforcement stay core-owned.

`image.*` is not core vocabulary. Apps use app-owned ingress events such as
`img.request.created` and package calls such as `generateImageEffect`; they do
not write `image.*` facts directly when the DO registers the image extension
package.

## v0 Shape

```text
@agent-os/core
  RefResolver
  ExtensionPackage negative gate
  dispatch/resource/idempotency truth

@agent-os/image
  ImageRoute / ImageArtifact / ImageResult
  openai-chat-compatible-image
  cf-ai-binding-image
  generateImageEffect()
  imageExtensionPackage(version)
  IMAGE_EVENTS
  projectImageJobs()
  imageJobIdempotencyKey()
  withImageResourceSettlement()
```

No `ArtifactStore` in v0. R2 bytes remain app/carrier code; ledgers store refs.

## App Event Boundary

Allowed app facts:

```text
img.request.created
img.plan.ready
credit.reserve.requested
credit.reserved
artifact.delivered
```

The names above are illustrative. Production apps should namespace app facts
under their own product prefix, such as `<app>.img.request.created`, so future
substrate-reserved prefixes do not collide with app-owned ledgers.

Package-owned facts:

```text
image.job.requested
image.provider.completed
image.artifact.materialized
image.job.failed
image.job.cancelled
```

The second set is for package/projector vocabulary. Core rejects it only for DO
classes that return `imageExtensionPackage(version)` from
`registerExtensions()`. v0 has no positive package commit API; the declaration
only prevents app-facing core write paths from forging image facts.
