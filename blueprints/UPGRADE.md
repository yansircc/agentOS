# Blueprint Upgrade Guide

<!-- agentos:blueprint-upgrade id="provider.material-binding" -->
<!-- agentos:blueprint-upgrade id="sandbox.lifecycle-boundary" -->
<!-- agentos:blueprint-upgrade id="channel.inbound" -->

## provider.material-binding

Keep provider material binding as app-owned configuration. Do not move provider
creation, reuse, deletion, credential loading, network policy, secret preflight,
or transport-specific wiring into `@agent-os/runtime`.

## sandbox.lifecycle-boundary

Keep sandbox resource lifecycle as app-owned or generated target source.
Runtime may expose stable contracts and pure adapters, but it does not own
sandbox creation, reuse, deletion, credentials, or network policy.

## channel.inbound

Keep provider ingress in `agent/channels/<name>.ts`. The generated target owns
mounting and the pure channel context; app-owned channel code owns request
verification, provider SDK use, deduplication, outbound calls, and secret
redaction before submit or dispatch.
