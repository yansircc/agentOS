/**
 * Resources over the test-only in-memory DO subset.
 *
 * This keeps the production runtime Cloudflare-only while giving property
 * tests a fast substrate for the synchronous transaction semantics that
 * resource reservation depends on.
 */

import * as fc from "fast-check";
import { Cause, Exit, Layer, ManagedRuntime, Option } from "effect";
import { describe, expect, it } from "@effect/vitest";

import { EventBusLive, Ledger, LedgerLive } from "../src/ledger";
import { Resources, ResourcesLive } from "../src/resources";
import type { EventHandler } from "@agent-os/kernel/types";

import { makeInMemoryDurableObjectState } from "./_in-memory-do";

const keys = ["credit", "token", "image"] as const;

type Key = (typeof keys)[number];

type HistoryStep =
  | {
      readonly kind: "grant";
      readonly key: Key;
      readonly amount: number;
      readonly ref: string;
    }
  | {
      readonly kind: "reserve";
      readonly key: Key;
      readonly amount: number;
      readonly ref: string;
    }
  | {
      readonly kind: "terminal";
      readonly terminalKind: "consume" | "release";
      readonly pick: number;
      readonly ref: string;
    };

interface ModelReservation {
  readonly key: Key;
  readonly amount: number;
  status: "active" | "consumed" | "released";
}

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
    terminalKind: fc.constantFrom("consume", "release"),
    pick: fc.nat(),
    ref: refArb,
  }),
);

const makeRuntime = () => {
  const state = makeInMemoryDurableObjectState();
  const handlers = new Map<string, Set<EventHandler>>();
  const eventBus = EventBusLive(handlers);
  const ledger = LedgerLive(state.storage.sql).pipe(Layer.provide(eventBus));
  const resources = ResourcesLive(state).pipe(Layer.provide(eventBus));
  return ManagedRuntime.make(Layer.mergeAll(ledger, resources));
};

const sumGranted = (grants: ReadonlyMap<Key, number>, key: Key): number => grants.get(key) ?? 0;

const projectModel = (
  grants: ReadonlyMap<Key, number>,
  reservations: ReadonlyMap<string, ModelReservation>,
  key: Key,
): {
  readonly available: number;
  readonly reserved: number;
  readonly consumed: number;
} => {
  let reserved = 0;
  let consumed = 0;
  for (const reservation of reservations.values()) {
    if (reservation.key !== key) continue;
    if (reservation.status === "active") reserved += reservation.amount;
    if (reservation.status === "consumed") consumed += reservation.amount;
  }
  return {
    available: sumGranted(grants, key) - reserved - consumed,
    reserved,
    consumed,
  };
};

const activeReservationIds = (reservations: ReadonlyMap<string, ModelReservation>): string[] =>
  Array.from(reservations.entries())
    .filter(([, reservation]) => reservation.status === "active")
    .map(([reservationId]) => reservationId);

describe("in-memory DO subset", () => {
  it("rolls back synchronous SQL writes when transactionSync throws", () => {
    const state = makeInMemoryDurableObjectState();

    expect(() =>
      state.storage.transactionSync(() => {
        state.storage.sql.exec(`
          CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts INTEGER NOT NULL,
            kind TEXT NOT NULL,
            scope TEXT NOT NULL,
            payload TEXT NOT NULL
          )
        `);
        state.storage.sql.exec(
          "INSERT INTO events (ts, kind, scope, payload) VALUES (?, ?, ?, ?) RETURNING id",
          1,
          "resource.granted",
          "scope-a",
          JSON.stringify({ key: "credit", amount: 1, ref: "seed" }),
        );
        throw new Error("rollback");
      }),
    ).toThrow("rollback");

    expect(
      state.storage.sql
        .exec("SELECT * FROM events WHERE scope = ? AND id > ? ORDER BY id ASC", "scope-a", 0)
        .toArray(),
    ).toEqual([]);
  });

  it("runs resource reservation histories without Wrangler", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(historyStepArb, { maxLength: 80 }), async (steps) => {
        const scope = `in-memory-resource-${crypto.randomUUID()}`;
        const runtime = makeRuntime();
        try {
          const resources = await runtime.runPromise(Resources);
          const ledger = await runtime.runPromise(Ledger);
          const grants = new Map<Key, number>();
          const reservations = new Map<string, ModelReservation>();
          let nextIdempotency = 0;

          for (const step of steps) {
            if (step.kind === "grant") {
              await runtime.runPromise(resources.grant(scope, step));
              grants.set(step.key, (grants.get(step.key) ?? 0) + step.amount);
              continue;
            }

            if (step.kind === "reserve") {
              const projected = projectModel(grants, reservations, step.key);
              const idempotencyKey = `idem-${nextIdempotency++}`;
              if (projected.available < step.amount) {
                const exit = await runtime.runPromiseExit(
                  resources.reserve(scope, { ...step, idempotencyKey }),
                );
                expect(Exit.isFailure(exit)).toBe(true);
                if (Exit.isFailure(exit)) {
                  const failure = Cause.failureOption(exit.cause);
                  expect(Option.isSome(failure)).toBe(true);
                  if (Option.isSome(failure)) {
                    expect(failure.value._tag).toBe("agent_os.resource_insufficient");
                  }
                }
                continue;
              }

              const { reservationId } = await runtime.runPromise(
                resources.reserve(scope, { ...step, idempotencyKey }),
              );
              reservations.set(reservationId, {
                key: step.key,
                amount: step.amount,
                status: "active",
              });
              continue;
            }

            const activeIds = activeReservationIds(reservations);
            if (activeIds.length === 0) continue;
            const reservationId = activeIds[step.pick % activeIds.length]!;
            const reservation = reservations.get(reservationId)!;
            if (step.terminalKind === "consume") {
              await runtime.runPromise(resources.consume(scope, { reservationId, ref: step.ref }));
              reservation.status = "consumed";
            } else {
              await runtime.runPromise(resources.release(scope, { reservationId, ref: step.ref }));
              reservation.status = "released";
            }
          }

          const events = await runtime.runPromise(ledger.events(scope));
          expect(events.map((event) => event.id)).toEqual(
            events.map((event) => event.id).sort((a, b) => a - b),
          );
          for (const key of keys) {
            await expect(runtime.runPromise(resources.project(scope, key))).resolves.toEqual(
              projectModel(grants, reservations, key),
            );
          }
        } finally {
          await runtime.dispose();
        }
      }),
      { numRuns: 200 },
    );
  });
});
