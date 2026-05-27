/**
 * Dispatch receiver projection model tests.
 *
 * Receiver idempotency is exactly (sourceScope, idempotencyKey). The sender's
 * outboundEventId is audit metadata and must not affect duplicate detection.
 */

import * as fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";

import { type InboundAcceptedPayload, findAcceptedInRows } from "../src/dispatch/receiver";
import { makePreClaim, settleLivedClaim } from "../src/effect-claim";

const sourceScopes = ["source-a", "source-b", "source-c"] as const;
const idempotencyKeys = ["idem-a", "idem-b", "idem-c"] as const;
const livedClaim = settleLivedClaim(
  makePreClaim({
    operationRef: "dispatch:source:target:intent",
    scopeRef: { kind: "conversation", scopeId: "target" },
    authorityRef: { authorityId: "cap_dispatch", authorityClass: "effect" },
    originRef: { originId: "source", originKind: "agent_do" },
  }),
  { anchorId: "target:1", anchorKind: "ledger_event" },
);

const payloadArb: fc.Arbitrary<InboundAcceptedPayload> = fc.record({
  sourceScope: fc.constantFrom(...sourceScopes),
  outboundEventId: fc.integer({ min: 1, max: 1000 }),
  idempotencyKey: fc.constantFrom(...idempotencyKeys),
  deliveredEventId: fc.integer({ min: 1, max: 1000 }),
  claim: fc.constant(livedClaim),
});

const rowOf = (payload: InboundAcceptedPayload): { readonly payload: string } => ({
  payload: JSON.stringify(payload),
});

const oracle = (
  rows: ReadonlyArray<InboundAcceptedPayload>,
  sourceScope: string,
  idempotencyKey: string,
): InboundAcceptedPayload | null => {
  for (const row of rows) {
    if (row.sourceScope === sourceScope && row.idempotencyKey === idempotencyKey) {
      return row;
    }
  }
  return null;
};

describe("dispatch receiver idempotency properties", () => {
  it("selects the first matching (sourceScope, idempotencyKey)", () => {
    fc.assert(
      fc.property(
        fc.array(payloadArb, { maxLength: 200 }),
        fc.constantFrom(...sourceScopes),
        fc.constantFrom(...idempotencyKeys),
        (payloads, sourceScope, idempotencyKey) => {
          expect(findAcceptedInRows(payloads.map(rowOf), sourceScope, idempotencyKey)).toEqual(
            oracle(payloads, sourceScope, idempotencyKey),
          );
        },
      ),
      { numRuns: 1000 },
    );
  });

  it("ignores outboundEventId when detecting duplicates", () => {
    fc.assert(
      fc.property(
        payloadArb,
        fc.integer({ min: 1001, max: 2000 }),
        (first, laterOutboundEventId) => {
          const duplicate = {
            ...first,
            outboundEventId: laterOutboundEventId,
            deliveredEventId: first.deliveredEventId + 1,
          };
          expect(
            findAcceptedInRows(
              [rowOf(first), rowOf(duplicate)],
              first.sourceScope,
              first.idempotencyKey,
            ),
          ).toEqual(first);
        },
      ),
      { numRuns: 1000 },
    );
  });
});
