# a51: Attached Stream Substrate

## Situation

Vibe-like apps, routa-like sessions, and future skill install flows all need a
live entity that accepts multiple inputs, emits multiple outputs, can be
cancelled, and settles terminally. Durable triggers are batch-shaped and cannot
own this without turning every acquire into streaming acquire.

## Options

- Keep streams app-owned above agentOS.
- Convert durable triggers into streaming triggers.
- Add a separate attached stream substrate beside durable triggers.

## Decision

Add a separate attached stream substrate. Intermediate frames are transport,
not ledger facts. Handlers explicitly declare `mode`, `cancellation`,
`onDetach`, and `commitTerminal`. Cloudflare DO maps bidi handlers to
WebSocket and output-only handlers to SSE.

## Kill Criterion

If the first vibe-like app needs three or more app-local stream bypasses, a51 is
removed or redesigned. If that app and a second routa-like adoption both fit
the contract, the stream surface can move toward a stable posture.

## Revisit

Revisit when an app needs reconnect/resume, hour-long workspace sessions,
hibernation, durable stream logs, or when two apps independently need the same
stream extension.
