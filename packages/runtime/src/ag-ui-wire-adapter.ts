import { decodeSseHttpEvents, type SseHttpChunk } from "./sse-http";
import {
  decodeLedgerEventToAgUiEnvelope,
  encodeAgUiLedgerEventEnvelopeSse,
  type AgUiLedgerEnvelopeProjectionSpec,
  type AgUiLedgerEventEnvelope,
} from "./ag-ui";

export type AgUiSseChunk = SseHttpChunk;

export async function* projectLedgerSseToAgUiEnvelopes(
  chunks: AsyncIterable<AgUiSseChunk>,
  spec: AgUiLedgerEnvelopeProjectionSpec = {},
): AsyncGenerator<AgUiLedgerEventEnvelope> {
  for await (const parsed of decodeSseHttpEvents(chunks)) {
    if (parsed.event !== "ledger" || parsed.data.length === 0) continue;
    yield decodeLedgerEventToAgUiEnvelope(JSON.parse(parsed.data) as unknown, spec);
  }
}

export async function* projectLedgerSseToAgUiSse(
  chunks: AsyncIterable<AgUiSseChunk>,
  spec: AgUiLedgerEnvelopeProjectionSpec = {},
): AsyncGenerator<string> {
  for await (const envelope of projectLedgerSseToAgUiEnvelopes(chunks, spec)) {
    yield encodeAgUiLedgerEventEnvelopeSse(envelope);
  }
}
