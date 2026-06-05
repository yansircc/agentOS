import { Effect, Exit, Schema } from "effect";
import { describe, expect, it } from "@effect/vitest";
import type { LedgerEvent } from "@agent-os/kernel/types";
import {
  ProjectionReducerReturnedThenable,
  applyProjectionEvent,
  defineProjection,
  makeProjectionRegistry,
  projectionFail,
  projectionIdentity,
  projectionMalformed,
  projectionPut,
} from "../src/projection";

const eventIdentity = (scopeId: string) => ({
  scopeRef: { kind: "conversation" as const, scopeId },
  factOwnerRef: "@agent-os/test",
  effectAuthorityRef: { authorityClass: "test", authorityId: scopeId },
});

const event = (id: number, kind: string, payload: unknown): LedgerEvent => ({
  id,
  ts: id * 10,
  kind,
  ...eventIdentity("projection-scope"),
  payload,
});

const payload = (event: LedgerEvent): Record<string, unknown> =>
  event.payload !== null && typeof event.payload === "object"
    ? (event.payload as Record<string, unknown>)
    : {};

const runProjection = defineProjection({
  kind: "run.workflow",
  version: 1,
  eventKinds: ["run.requested", "run.completed"],
  identity: Schema.Struct({ runId: Schema.String }),
  state: Schema.Struct({
    runId: Schema.String,
    status: Schema.Literal("requested", "completed"),
  }),
  identityKey: (identity) => identity.runId,
  identify: (row) => {
    const runId = payload(row).runId;
    return typeof runId === "string"
      ? projectionIdentity({ runId })
      : projectionMalformed("runId is required");
  },
  initial: (identity) => ({ runId: identity.runId, status: "requested" as const }),
  reduce: (state, row) =>
    row.kind === "run.completed"
      ? projectionPut({ ...state, status: "completed" as const })
      : projectionPut(state),
});

describe("materialized projection runtime algebra", () => {
  it.effect("rejects invalid projection registries", () =>
    Effect.gen(function* () {
      const duplicate = yield* Effect.exit(makeProjectionRegistry([runProjection, runProjection]));
      expect(Exit.isFailure(duplicate)).toBe(true);

      const noEvents = yield* Effect.exit(
        makeProjectionRegistry([{ ...runProjection, kind: "no.events", eventKinds: [] }]),
      );
      expect(Exit.isFailure(noEvents)).toBe(true);

      const badVersion = yield* Effect.exit(
        makeProjectionRegistry([{ ...runProjection, kind: "bad.version", version: 0 }]),
      );
      expect(Exit.isFailure(badVersion)).toBe(true);
    }),
  );

  it.effect("applies multiple event kinds with one identity/state algebra", () =>
    Effect.gen(function* () {
      const requested = yield* applyProjectionEvent(
        runProjection,
        event(1, "run.requested", { runId: "r1" }),
        () => null,
      );
      expect(requested).toMatchObject({
        _tag: "put",
        identityKey: "r1",
        state: { runId: "r1", status: "requested" },
      });
      if (requested._tag !== "put") return;

      const completed = yield* applyProjectionEvent(
        runProjection,
        event(2, "run.completed", { runId: "r1" }),
        () => ({ identity: requested.identity, state: requested.state }),
      );
      expect(completed).toMatchObject({
        _tag: "put",
        identityKey: "r1",
        state: { runId: "r1", status: "completed" },
      });
    }),
  );

  it.effect("fails closed on malformed identity, malformed state, and thenable reducers", () =>
    Effect.gen(function* () {
      const malformed = yield* Effect.exit(
        applyProjectionEvent(runProjection, event(1, "run.requested", {}), () => null),
      );
      expect(Exit.isFailure(malformed)).toBe(true);

      const badState = defineProjection({
        ...runProjection,
        kind: "run.bad_state",
        reduce: () => projectionPut({ runId: "r1", status: "impossible" } as never),
      });
      const badStateExit = yield* Effect.exit(
        applyProjectionEvent(badState, event(2, "run.requested", { runId: "r1" }), () => null),
      );
      expect(Exit.isFailure(badStateExit)).toBe(true);

      const thenable = defineProjection({
        ...runProjection,
        kind: "run.thenable",
        reduce: () => Promise.resolve(projectionFail("async")) as never,
      });
      const thenableExit = yield* Effect.exit(
        applyProjectionEvent(thenable, event(3, "run.requested", { runId: "r1" }), () => null),
      );
      expect(Exit.isFailure(thenableExit)).toBe(true);
      const cause = thenableExit._tag === "Failure" ? Exit.causeOption(thenableExit) : undefined;
      void cause;
    }),
  );

  it.effect("treats explicit malformed identify as projection application failure", () =>
    Effect.gen(function* () {
      const projection = defineProjection({
        ...runProjection,
        kind: "run.malformed",
        identify: () => projectionMalformed("bad identity"),
      });
      const exit = yield* Effect.exit(
        applyProjectionEvent(projection, event(1, "run.requested", { runId: "r1" }), () => null),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it("exposes the thenable error class for backend rollback classification", () => {
    const error = new ProjectionReducerReturnedThenable({ kind: "run.thenable", eventId: 1 });
    expect(error._tag).toBe("agent_os.projection_reducer_returned_thenable");
  });
});
