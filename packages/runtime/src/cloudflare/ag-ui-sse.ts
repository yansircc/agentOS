import {
  decodeAgUiRecordedLedgerEvent,
  encodeAgUiLedgerEventEnvelopeSse,
  projectLedgerEventsToAgUiEnvelopes,
  projectLedgerSseToAgUiSse,
  type AgUiLedgerEnvelopeProjectionSpec,
} from "@agent-os/ag-ui";
import type { LedgerEvent } from "@agent-os/core/types";
import {
  createSseHttpResponse,
  createSseHttpTextResponse,
  responseToSseHttpChunks,
  type SseHttpResponseOptions,
  type SseHttpChunk,
} from "@agent-os/sse-http";

export type CloudflareLedgerSseSource = Response | AsyncIterable<SseHttpChunk>;

const ledgerSseChunks = (source: CloudflareLedgerSseSource): AsyncIterable<SseHttpChunk> =>
  source instanceof Response ? responseToSseHttpChunks(source) : source;

/**
 * Cloudflare host composition for live ledger SSE -> AG-UI SSE.
 *
 * This helper is host-agnostic internally: it only composes the AG-UI
 * projection with the Web Fetch SSE response wrapper. It intentionally lives
 * in cloudflare-do for v1 to avoid a one-consumer transport package. If a
 * second host needs the same helper, move the body to
 * `transports/ag-ui-sse` and leave this export as a thin re-export.
 *
 * @agentosPrimitive primitive.cloudflare-do.createCloudflareLedgerAgUiSseResponse
 * @agentosInvariant invariant.ag-ui.sse-axis
 * @agentosDocs docs/packages/runtime.md
 * @public
 */
export const createCloudflareLedgerAgUiSseResponse = (
  ledgerSse: CloudflareLedgerSseSource,
  spec: AgUiLedgerEnvelopeProjectionSpec = {},
  options: SseHttpResponseOptions = {},
): Response =>
  createSseHttpResponse(projectLedgerSseToAgUiSse(ledgerSseChunks(ledgerSse), spec), options);

/**
 * Cloudflare host composition for historical ledger rows -> AG-UI SSE.
 *
 * Raw ledger history remains the truth source; this function only materializes
 * a transport response from a supplied snapshot.
 *
 * @agentosPrimitive primitive.cloudflare-do.createCloudflareLedgerAgUiHistorySseResponse
 * @agentosInvariant invariant.ag-ui.sse-axis
 * @agentosDocs docs/packages/runtime.md
 * @public
 */
export const createCloudflareLedgerAgUiHistorySseResponse = (
  events: ReadonlyArray<LedgerEvent>,
  spec: AgUiLedgerEnvelopeProjectionSpec = {},
  options: Omit<SseHttpResponseOptions, "onCancel"> = {},
): Response =>
  createSseHttpTextResponse(
    projectLedgerEventsToAgUiEnvelopes(events.map(decodeAgUiRecordedLedgerEvent), spec)
      .map((envelope) => encodeAgUiLedgerEventEnvelopeSse(envelope))
      .join(""),
    options,
  );
