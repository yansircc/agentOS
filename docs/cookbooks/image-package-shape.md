# Image Package Shape

## Invariant

Image algebra is package-owned; ledger and runtime enforcement stay core-owned.

`image.*` is reserved. Apps use app-owned ingress events such as
`img.request.created` and core methods such as `generateImage`; they do not
write `image.*` facts directly.

## v0 Shape

```text
@agent-os/core
  AgentDOBase.generateImage()
  CORE_RESERVED_PREFIXES includes image.
  dispatch/resource/idempotency truth

@agent-os/image
  ImageRoute / ImageArtifact / ImageResult
  openai-chat-compatible-image
  cf-ai-binding-image
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

Reserved substrate facts:

```text
image.job.requested
image.provider.completed
image.artifact.materialized
image.job.failed
image.job.cancelled
```

The second set is for package/projector vocabulary. Public core write methods
reject it until a privileged image job writer exists.
