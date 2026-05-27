/**
 * Effect SQL over DO SQLite, constrained to a read facade.
 *
 * This test proves @effect/sql-sqlite-do can read ledger rows written by the
 * existing LedgerLive path without moving the critical write transactions.
 */

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it } from "@effect/vitest";

import { Ledger, LedgerLive, EventBusLive } from "../src/ledger";
import {
  EffectSqliteDoReadLive,
  selectLedgerEventsWithEffectSql,
} from "../src/storage/effect-sqlite-do";
import type { EventHandler } from "../src/types";

import type { TestAgentDO } from "./test-worker";

interface TestEnv {
  readonly AGENT_DO: DurableObjectNamespace<TestAgentDO>;
}

const testEnv = env as unknown as TestEnv;

const makeRuntime = (state: DurableObjectState) => {
  const handlers = new Map<string, Set<EventHandler>>();
  const eventBus = EventBusLive(handlers);
  const ledger = LedgerLive(state.storage.sql).pipe(Layer.provide(eventBus));
  const effectSql = EffectSqliteDoReadLive(state.storage.sql);
  return ManagedRuntime.make(Layer.mergeAll(ledger, effectSql));
};

describe("@effect/sql-sqlite-do read facade", () => {
  it("reads ledger rows written by LedgerLive without owning transactionSync", async () => {
    const scope = "effect-sql-read-facade";
    const stub = testEnv.AGENT_DO.get(testEnv.AGENT_DO.idFromName(scope));

    await runInDurableObject(stub, async (_instance, state) => {
      const runtime = makeRuntime(state);
      try {
        const rows = await runtime.runPromise(
          Effect.gen(function* () {
            const ledger = yield* Ledger;
            yield* ledger.log("test.one", { n: 1 }, scope);
            yield* ledger.log("test.two", { n: 2 }, scope);
            return yield* selectLedgerEventsWithEffectSql(scope, {
              afterId: 0,
              limit: 10,
            });
          }),
        );

        expect(rows.map((row) => row.kind)).toEqual(["test.one", "test.two"]);
        expect(rows.map((row) => row.payload)).toEqual([{ n: 1 }, { n: 2 }]);
      } finally {
        await runtime.dispose();
      }
    });
  });
});
