/**
 * Ledger stream handoff model tests.
 *
 * The stream startup algorithm emits snapshot rows first, then drains buffered
 * live rows strictly after the snapshot watermark. This is the no-gap /
 * no-duplicate core of spec-29 without opening a Workers SSE stream.
 */

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { selectHandoffEvents } from "../src/ledger/stream";
import type { LedgerEvent } from "../src/types";

const uniqueSorted = (values: ReadonlyArray<number>): ReadonlyArray<number> =>
  Array.from(new Set(values)).sort((a, b) => a - b);

const eventOf = (id: number): LedgerEvent => ({
  id,
  ts: id,
  kind: `event.${id}`,
  scope: "scope-a",
  payload: { id },
});

describe("ledger stream handoff properties", () => {
  it("emits snapshot rows plus only live rows after the watermark", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 500 }),
        fc.array(fc.integer({ min: 1, max: 1000 }), { maxLength: 200 }),
        fc.array(fc.integer({ min: 1, max: 1000 }), { maxLength: 200 }),
        (afterId, snapshotRaw, liveExtraRaw) => {
          const snapshotIds = uniqueSorted(
            snapshotRaw.filter((id) => id > afterId),
          );
          const snapshotWatermark =
            snapshotIds.length === 0
              ? afterId
              : Math.max(
                  afterId,
                  snapshotIds[snapshotIds.length - 1] ?? afterId,
                );
          const extraLiveIds = uniqueSorted(
            liveExtraRaw.filter((id) => id > snapshotWatermark),
          );
          const liveIds = uniqueSorted([...snapshotIds, ...extraLiveIds]);

          const result = selectHandoffEvents(
            afterId,
            snapshotIds.map(eventOf),
            liveIds.map(eventOf),
          );

          expect(result.events.map((event) => event.id)).toEqual([
            ...snapshotIds,
            ...extraLiveIds,
          ]);
          expect(result.watermark).toBe(
            extraLiveIds[extraLiveIds.length - 1] ??
              snapshotIds[snapshotIds.length - 1] ??
              afterId,
          );
        },
      ),
      { numRuns: 1000 },
    );
  });
});
