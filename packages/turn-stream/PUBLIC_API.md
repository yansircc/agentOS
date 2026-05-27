# @agent-os/turn-stream Public API

Status: 1.0 target for frame algebra. Provider delta adapters added before 1.0 must be listed here.

## Frozen exports

- `.:TurnDoneFrame`
- `.:TurnErrorFrame`
- `.:TurnMetadataFrame`
- `.:TurnStreamFrame`
- `.:TurnStreamOmitReason`
- `.:TurnStreamOmittedFrame`
- `.:TurnStreamProjection`
- `.:TurnStreamStatus`
- `.:TurnStreamDeltaAdapterInput`
- `.:TurnTextDeltaFrame`
- `.:OpenAiCompatibleDeltaChoice`
- `.:OpenAiCompatibleDeltaChunk`
- `.:AnthropicDeltaChunk`
- `.:GeminiDeltaChunk`
- `.:adaptOpenAiCompatibleDeltaChunk`
- `.:adaptAnthropicDeltaChunk`
- `.:adaptGeminiDeltaChunk`
- `.:decodeTurnStreamData`
- `.:encodeTurnStreamSse`
- `.:isTurnStreamFrame`
- `.:projectTurnStream`

## Experimental exports

None.

## Internal-only exports

Any package file or symbol not listed above.
