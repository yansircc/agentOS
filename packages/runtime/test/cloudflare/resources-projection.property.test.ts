/**
 * Resource projection model tests.
 *
 * The oracle is the conservation law for resource ledgers:
 *   available + reserved + consumed = sum(resource_pool.granted)
 * for every resource key, regardless of terminal/reject noise.
 */

import * as fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";

import {
  type ProjectedState,
  type ResourceEventRow,
  projectRows,
} from "../../src/cloudflare/resources/projection";

type ResourceRowSpec =
  | {
      readonly kind: "resource_pool.granted";
      readonly key: string;
      readonly amount: number;
      readonly ref: string;
    }
  | {
      readonly kind: "resource_pool.reserved";
      readonly key: string;
      readonly amount: number;
      readonly ref: string;
      readonly idempotencyKey: string;
      readonly reservationId: string;
    }
  | {
      readonly kind: "resource_pool.reserve_rejected";
      readonly key: string;
      readonly amount: number;
      readonly ref: string;
      readonly idempotencyKey: string;
      readonly available: number;
    }
  | {
      readonly kind: "resource_pool.consumed" | "resource_pool.released";
      readonly reservationId: string;
      readonly ref: string;
    };

const keys = ["credit", "token", "image"] as const;

type HistoryStep =
  | {
      readonly kind: "grant";
      readonly key: (typeof keys)[number];
      readonly amount: number;
      readonly ref: string;
    }
  | {
      readonly kind: "reserve";
      readonly key: (typeof keys)[number];
      readonly amount: number;
      readonly ref: string;
    }
  | {
      readonly kind: "terminal";
      readonly terminalKind: "resource_pool.consumed" | "resource_pool.released";
      readonly pick: number;
      readonly ref: string;
    };

const refArb = fc.string({ maxLength: 12 });

const historyStepArb: fc.Arbitrary<HistoryStep> = fc.oneof(
  fc.record({
    kind: fc.constant("grant"),
    key: fc.constantFrom(...keys),
    amount: fc.integer({ min: 1, max: 50 }),
    ref: refArb,
  }),
  fc.record({
    kind: fc.constant("reserve"),
    key: fc.constantFrom(...keys),
    amount: fc.integer({ min: 1, max: 50 }),
    ref: refArb,
  }),
  fc.record({
    kind: fc.constant("terminal"),
    terminalKind: fc.constantFrom("resource_pool.consumed", "resource_pool.released"),
    pick: fc.nat(),
    ref: refArb,
  }),
);

const reachableHistoryArb: fc.Arbitrary<ReadonlyArray<ResourceRowSpec>> = fc
  .array(historyStepArb, { maxLength: 200 })
  .map((steps) => {
    let nextReservationId = 0;
    let nextIdempotencyKey = 0;
    const availableByKey = new Map<string, number>();
    const active = new Map<string, { readonly key: string; readonly amount: number }>();
    const specs: ResourceRowSpec[] = [];

    const addAvailable = (key: string, delta: number): void => {
      availableByKey.set(key, (availableByKey.get(key) ?? 0) + delta);
    };

    for (const step of steps) {
      if (step.kind === "grant") {
        specs.push({
          kind: "resource_pool.granted",
          key: step.key,
          amount: step.amount,
          ref: step.ref,
        });
        addAvailable(step.key, step.amount);
        continue;
      }

      if (step.kind === "reserve") {
        const available = availableByKey.get(step.key) ?? 0;
        const idempotencyKey = `idem-${nextIdempotencyKey++}`;
        if (available < step.amount) {
          specs.push({
            kind: "resource_pool.reserve_rejected",
            key: step.key,
            amount: step.amount,
            ref: step.ref,
            idempotencyKey,
            available,
          });
          continue;
        }

        const reservationId = `reservation-${nextReservationId++}`;
        specs.push({
          kind: "resource_pool.reserved",
          key: step.key,
          amount: step.amount,
          ref: step.ref,
          idempotencyKey,
          reservationId,
        });
        addAvailable(step.key, -step.amount);
        active.set(reservationId, { key: step.key, amount: step.amount });
        continue;
      }

      const activeIds = Array.from(active.keys());
      if (activeIds.length === 0) continue;
      const reservationId = activeIds[step.pick % activeIds.length]!;
      const reservation = active.get(reservationId)!;
      specs.push({
        kind: step.terminalKind,
        reservationId,
        ref: step.ref,
      });
      active.delete(reservationId);
      if (step.terminalKind === "resource_pool.released") {
        addAvailable(reservation.key, reservation.amount);
      }
    }

    return specs;
  });

const toRow = (spec: ResourceRowSpec): ResourceEventRow => {
  const { kind, ...payload } = spec;
  return { kind, payload: JSON.stringify(payload) };
};

const grantTotals = (specs: ReadonlyArray<ResourceRowSpec>): Map<string, number> => {
  const totals = new Map<string, number>();
  for (const spec of specs) {
    if (spec.kind !== "resource_pool.granted") continue;
    totals.set(spec.key, (totals.get(spec.key) ?? 0) + spec.amount);
  }
  return totals;
};

const assertConservation = (state: ProjectedState, grants: ReadonlyMap<string, number>): void => {
  const allKeys = new Set([...grants.keys(), ...state.byKey.keys()]);
  for (const key of allKeys) {
    const projection = state.byKey.get(key) ?? {
      available: 0,
      reserved: 0,
      consumed: 0,
    };
    expect(projection.available + projection.reserved + projection.consumed).toBe(
      grants.get(key) ?? 0,
    );
  }
};

const assertIdempotencyIndexPointsAtReservations = (state: ProjectedState): void => {
  for (const reservation of state.byIdempotencyKey.values()) {
    expect(state.byId.get(reservation.reservationId)).toEqual(reservation);
  }
};

describe("resource projection properties", () => {
  it("conserves granted balance across generated resource histories", () => {
    fc.assert(
      fc.property(reachableHistoryArb, (specs) => {
        const state = projectRows(specs.map(toRow));
        assertConservation(state, grantTotals(specs));
        assertIdempotencyIndexPointsAtReservations(state);
      }),
      { numRuns: 1000 },
    );
  });
});
