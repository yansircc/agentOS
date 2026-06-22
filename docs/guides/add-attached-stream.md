# Add An Attached Stream

## Outcome

You can register an attached stream handler and expose live output through the
backend stream configuration.

## Prerequisites

- [Attached streams](../concepts/attached-streams.md)
- [Durable truth](../concepts/durable-truth.md)
- [Runtime package](../packages/runtime.md)
- [Runtime API](../api/runtime.md)

## Steps

1. Define an `AttachedStreamHandler` in app code.
2. Choose `mode: "bidi"` for WebSocket or `mode: "output_only"` for SSE.
3. Choose `cancellation` and `onDetach` explicitly.
4. Yield `output` or `progress` frames from `run`.
5. Yield one terminal frame and write durable facts in `commitTerminal`.
6. Register the handler in generated or backend-owned stream configuration.

## References

- [Runtime API](../api/runtime.md)
