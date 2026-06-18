import { Effect, Schema } from "effect";
import { describe, expect, it } from "@effect/vitest";
import type { LedgerEvent } from "@agent-os/kernel/types";
import { DISPATCH_INBOUND_ACCEPTED } from "@agent-os/backend-protocol";
import {
  defineProjection,
  makeProjectionRegistryResult,
  projectionFail,
  projectionIdentity,
  projectionPut,
} from "@agent-os/runtime";
import { RUNTIME_FACT_OWNER, runtimeHistoryCompactedEvent } from "@agent-os/runtime-protocol";
import type { AnyMaterializedProjectionDefinition, ProjectionRegistry } from "@agent-os/runtime";
import type { BackendProtocolTruthIdentity } from "@agent-os/backend-protocol";
import type { EventBusService } from "../src/ledger/event-bus";
import {
  commitLedgerTransaction,
  ensureLedgerSchema,
  type LedgerPayloadContext,
} from "../src/ledger/commit";
import { registerMaterializedProjectionRegistry } from "../src/materialized-projections";
import { makeInMemoryDurableObjectState } from "./_in-memory-do";

const recordingBus = (fired: LedgerEvent[]): EventBusService => ({
  fire: (event) => Effect.sync(() => void fired.push(event)),
  fireMany: (events) => Effect.sync(() => void fired.push(...events)),
  telemetryDiagnostics: () => [],
  subscribe: () => ({ unsubscribe: () => undefined }),
});

const projectionRegistry = (
  projections: ReadonlyArray<AnyMaterializedProjectionDefinition>,
): ProjectionRegistry => {
  const result = makeProjectionRegistryResult(projections);
  if (result._tag === "failure") throw result.error;
  return result.registry;
};

const truthIdentity = (scopeId: string): BackendProtocolTruthIdentity => ({
  scopeRef: { kind: "conversation", scopeId },
  effectAuthorityRef: { authorityClass: "effect", authorityId: scopeId },
});

const runtimeOwner = { factOwnerRef: RUNTIME_FACT_OWNER };

describe("cloudflare-do ledger commit primitive", () => {
  it.effect("applies projections over final symbolic payloads before bus fire", () =>
    Effect.gen(function* () {
      const state = makeInMemoryDurableObjectState();
      const sql = state.storage.sql;
      const fired: LedgerEvent[] = [];
      registerMaterializedProjectionRegistry(
        sql,
        projectionRegistry([
          defineProjection({
            kind: "dispatch.accepted.test",
            version: 1,
            eventKinds: [DISPATCH_INBOUND_ACCEPTED],
            identity: Schema.Struct({ key: Schema.String }),
            state: Schema.Struct({ deliveredEventId: Schema.Number }),
            identityKey: (identity) => identity.key,
            identify: () => projectionIdentity({ key: "single" }),
            initial: () => ({ deliveredEventId: 0 }),
            reduce: (_state, event) => {
              const payload = event.payload as { readonly deliveredEventId?: unknown };
              return typeof payload.deliveredEventId === "number"
                ? projectionPut({ deliveredEventId: payload.deliveredEventId })
                : projectionFail("deliveredEventId missing");
            },
          }),
        ]),
      );

      const identity = truthIdentity("receiver");
      const committed = yield* commitLedgerTransaction(
        state,
        recordingBus(fired),
        runtimeOwner,
        (tx) => {
          const accepted = tx.ref("accepted");
          const delivered = tx.ref("delivered");
          tx.append(accepted, {
            ts: 10,
            kind: DISPATCH_INBOUND_ACCEPTED,
            scopeRef: identity.scopeRef,
            effectAuthorityRef: identity.effectAuthorityRef,
            buildPayload: ({ id }: LedgerPayloadContext) => ({
              sourceScope: "sender",
              outboundEventId: 1,
              idempotencyKey: "k",
              deliveredEventId: id(delivered),
            }),
          });
          tx.append(delivered, {
            ts: 10,
            kind: "app.delivered",
            scopeRef: identity.scopeRef,
            effectAuthorityRef: identity.effectAuthorityRef,
            payload: { ok: true },
          });
        },
      );

      expect(committed.events.map((event) => event.id)).toEqual([1, 2]);
      const row = sql
        .exec(
          "SELECT state_json FROM materialized_projection_rows WHERE kind = ?",
          "dispatch.accepted.test",
        )
        .one() as { readonly state_json: string };
      expect(JSON.parse(row.state_json)).toEqual({ deliveredEventId: 2 });
      expect(fired.map((event) => [event.id, event.payload])).toEqual([
        [
          1,
          {
            sourceScope: "sender",
            outboundEventId: 1,
            idempotencyKey: "k",
            deliveredEventId: 2,
          },
        ],
        [2, { ok: true }],
      ]);
    }),
  );

  it.effect(
    "rolls back ledger rows, side effects, projections, and bus fire on reducer failure",
    () =>
      Effect.gen(function* () {
        const state = makeInMemoryDurableObjectState();
        const sql = state.storage.sql;
        ensureLedgerSchema(sql);
        sql.exec("CREATE TABLE IF NOT EXISTS side_effects (label TEXT NOT NULL)");
        const fired: LedgerEvent[] = [];
        registerMaterializedProjectionRegistry(
          sql,
          projectionRegistry([
            defineProjection({
              kind: "rollback.test",
              version: 1,
              eventKinds: ["rollback.fail"],
              identity: Schema.Struct({ key: Schema.String }),
              state: Schema.Struct({ key: Schema.String }),
              identityKey: (identity) => identity.key,
              identify: () => projectionIdentity({ key: "single" }),
              initial: () => ({ key: "single" }),
              reduce: () => projectionFail("forced failure"),
            }),
          ]),
        );

        const exit = yield* Effect.exit(
          commitLedgerTransaction(state, recordingBus(fired), runtimeOwner, (tx) => {
            const identity = truthIdentity("rollback");
            tx.append({
              ts: 20,
              kind: "rollback.fail",
              scopeRef: identity.scopeRef,
              effectAuthorityRef: identity.effectAuthorityRef,
              payload: { ok: false },
            });
            tx.afterInsert(() => {
              sql.exec("INSERT INTO side_effects (label) VALUES (?)", "written");
            });
          }),
        );

        expect(exit._tag).toBe("Failure");
        expect(sql.exec("SELECT * FROM events").toArray()).toHaveLength(0);
        expect(sql.exec("SELECT * FROM side_effects").toArray()).toHaveLength(0);
        expect(sql.exec("SELECT * FROM materialized_projection_rows").toArray()).toHaveLength(0);
        expect(fired).toEqual([]);
      }),
  );

  it.effect("rejects invalid runtime transitions before insert", () =>
    Effect.gen(function* () {
      const state = makeInMemoryDurableObjectState();
      const sql = state.storage.sql;
      ensureLedgerSchema(sql);
      const fired: LedgerEvent[] = [];
      const identity = truthIdentity("runtime-l0");

      const exit = yield* Effect.exit(
        commitLedgerTransaction(state, recordingBus(fired), runtimeOwner, (tx) => {
          tx.append({
            ts: 10,
            ...runtimeHistoryCompactedEvent({
              ...identity,
              runId: 1,
              turn: { id: 1, index: 0 },
              sourceEventId: 1,
              toolCallId: "call-1",
              toolName: "lookup",
              originalBytes: 256,
              compactedBytes: 16,
            }),
          });
        }),
      );

      expect(exit._tag).toBe("Failure");
      expect(sql.exec("SELECT * FROM events").toArray()).toHaveLength(0);
      expect(fired).toEqual([]);
    }),
  );

  it.effect(
    "initializes explicit ledger sequence from MAX(events.id)+1 and fires in id order",
    () =>
      Effect.gen(function* () {
        const state = makeInMemoryDurableObjectState();
        const sql = state.storage.sql;
        const identity = truthIdentity("sequence");
        yield* commitLedgerTransaction(state, recordingBus([]), runtimeOwner, (tx) => {
          for (let index = 1; index <= 41; index += 1) {
            tx.append({
              ts: index,
              kind: "seed.event",
              scopeRef: identity.scopeRef,
              effectAuthorityRef: identity.effectAuthorityRef,
              payload: { index },
            });
          }
        });
        sql.exec("DELETE FROM ledger_sequences WHERE name = ?", "events");
        const fired: LedgerEvent[] = [];

        const committed = yield* commitLedgerTransaction(
          state,
          recordingBus(fired),
          runtimeOwner,
          (tx) => {
            tx.append({
              ts: 42,
              kind: "next.one",
              scopeRef: identity.scopeRef,
              effectAuthorityRef: identity.effectAuthorityRef,
              payload: { n: 1 },
            });
            tx.append({
              ts: 43,
              kind: "next.two",
              scopeRef: identity.scopeRef,
              effectAuthorityRef: identity.effectAuthorityRef,
              payload: { n: 2 },
            });
          },
        );

        expect(committed.events.map((event) => event.id)).toEqual([42, 43]);
        expect(fired.map((event) => event.id)).toEqual([42, 43]);
        const sequence = sql
          .exec("SELECT next_id FROM ledger_sequences WHERE name = ?", "events")
          .one() as { readonly next_id: number };
        expect(Number(sequence.next_id)).toBe(44);
      }),
  );
});
