import type { EventQueryOptions, LedgerEvent } from "@agent-os/core/types";
import { createSseHttpTextResponse, encodeSseHttpData } from "../sse-http";
import { createLocalRuntimeLedgerSource } from "./runtime-ledger-source";

export type LocalRuntimeLedgerSnapshotSource =
  | ReadonlyArray<LedgerEvent>
  | ((opts?: EventQueryOptions) => ReadonlyArray<LedgerEvent>);

export interface LocalRuntimeLedgerSnapshotSseOptions {
  readonly query?: EventQueryOptions;
  readonly headers?: HeadersInit;
}

const snapshotEvents = (
  source: LocalRuntimeLedgerSnapshotSource,
  query: EventQueryOptions | undefined,
): ReadonlyArray<LedgerEvent> =>
  typeof source === "function"
    ? source(query)
    : createLocalRuntimeLedgerSource({ events: source }).events(query);

const encodeLedgerEvent = (event: LedgerEvent): string =>
  [`id: ${event.id}`, "event: ledger", encodeSseHttpData(event), "", ""].join("\n");

/**
 * Encodes a closed, snapshot-only local runtime ledger SSE body.
 *
 * This is not a live stream: callers pass the current local ledger snapshot and
 * the returned body closes after those rows. A true local live stream requires a
 * runtime-owned append notification primitive; polling is intentionally not
 * hidden behind this helper.
 *
 * @public
 */
export const encodeLocalRuntimeLedgerSnapshotSse = (
  source: LocalRuntimeLedgerSnapshotSource,
  query?: EventQueryOptions,
): string => snapshotEvents(source, query).map(encodeLedgerEvent).join("");

/**
 * Creates a closed, snapshot-only local runtime ledger SSE Response.
 *
 * The wire contains `event: ledger` frames whose `data` field is the JSON
 * ledger row. The response is intentionally finite; product shells that need
 * local live tailing must first install a runtime-owned append notification
 * source instead of poll-diffing this snapshot endpoint.
 *
 * @public
 */
export const createLocalRuntimeLedgerSnapshotSseResponse = (
  source: LocalRuntimeLedgerSnapshotSource,
  options: LocalRuntimeLedgerSnapshotSseOptions = {},
): Response =>
  createSseHttpTextResponse(encodeLocalRuntimeLedgerSnapshotSse(source, options.query), {
    ...(options.headers === undefined ? {} : { headers: options.headers }),
  });
