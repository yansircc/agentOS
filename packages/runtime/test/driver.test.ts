import { Effect, Exit } from "effect";
import { describe, expect, it } from "@effect/vitest";
import type { Recorded } from "@agent-os/core";
import { decodeRecordedLedgerEvent, type LedgerEvent } from "@agent-os/core/types";
import {
  RUNTIME_EVENT_KIND,
  agentRunStartedEvent,
  agentSessionTurnSubmittedEvent,
  type RuntimeEventCommitSpec,
} from "@agent-os/core/runtime-protocol";
import { appendRuntimeDriverAction } from "../src/driver";

const identity = {
  scopeRef: { kind: "conversation" as const, scopeId: "driver-test" },
  effectAuthorityRef: { authorityClass: "test", authorityId: "driver" },
};

const eventFromSpec = (id: number, spec: RuntimeEventCommitSpec): LedgerEvent => ({
  id,
  ts: id * 10,
  kind: spec.kind,
  scopeRef: spec.scopeRef,
  factOwnerRef: "@agent-os/test",
  effectAuthorityRef: spec.effectAuthorityRef,
  payload: spec.payload,
});

const recordedEventFromSpec = (id: number, spec: RuntimeEventCommitSpec) =>
  decodeRecordedLedgerEvent(eventFromSpec(id, spec));

describe("runtime driver value-domain boundary", () => {
  it.effect("returns decoded Recorded runtime events from driver appends", () =>
    Effect.gen(function* () {
      const event = agentRunStartedEvent({ ...identity, intent: "run" });
      const result = yield* appendRuntimeDriverAction(
        {
          commit: (specs) =>
            Effect.succeed(
              specs.map((spec, index) =>
                recordedEventFromSpec(index + 1, spec as RuntimeEventCommitSpec),
              ),
            ),
          commitPrepared: () => Effect.succeed([]),
        },
        { kind: "start", event },
      );
      const recorded: Recorded<typeof result.event.value> = result.event;

      expect(result.kind).toBe("start");
      expect(result.event.kind).toBe(RUNTIME_EVENT_KIND.AGENT_RUN_STARTED);
      expect(recorded.value.kind).toBe(RUNTIME_EVENT_KIND.AGENT_RUN_STARTED);
      expect(Object.prototype.propertyIsEnumerable.call(result.event, "value")).toBe(false);
    }),
  );

  it.effect("commits start and product link in one prepared driver append", () =>
    Effect.gen(function* () {
      const start = agentRunStartedEvent({ ...identity, intent: "session turn" });
      const committed: LedgerEvent[] = [];
      const result = yield* appendRuntimeDriverAction(
        {
          commit: () => Effect.die("unused commit"),
          commitPrepared: (build) =>
            Effect.sync(() => {
              const startRef = { key: "agent.run.started" };
              const ids = new Map<string, number>();
              const recipes: Array<{
                readonly ref: { readonly key: string };
                readonly recipe: {
                  readonly kind: string;
                  readonly payload?: unknown;
                  readonly buildPayload?: (context: {
                    readonly id: (ref: { readonly key: string }) => number;
                  }) => unknown;
                  readonly scopeRef: LedgerEvent["scopeRef"];
                  readonly effectAuthorityRef: LedgerEvent["effectAuthorityRef"];
                };
              }> = [];
              const builder = {
                ref: () => startRef,
                id: (ref: { readonly key: string }) => ids.get(ref.key) ?? 0,
                append: (refOrRecipe: any, maybeRecipe?: any) => {
                  const ref =
                    maybeRecipe === undefined ? { key: `event:${recipes.length}` } : refOrRecipe;
                  const recipe = maybeRecipe === undefined ? refOrRecipe : maybeRecipe;
                  ids.set(ref.key, recipes.length + 1);
                  recipes.push({ ref, recipe });
                  return ref;
                },
              };
              build(builder);
              const id = (ref: { readonly key: string }) => ids.get(ref.key) ?? 0;
              for (const { ref, recipe } of recipes) {
                const eventId = id(ref);
                committed.push(
                  eventFromSpec(eventId, {
                    kind: recipe.kind,
                    scopeRef: recipe.scopeRef,
                    effectAuthorityRef: recipe.effectAuthorityRef,
                    payload:
                      recipe.buildPayload === undefined
                        ? recipe.payload
                        : recipe.buildPayload({ id }),
                  } as RuntimeEventCommitSpec),
                );
              }
              return committed.map(decodeRecordedLedgerEvent);
            }),
        },
        {
          kind: "start_with_product_link",
          start,
          productLink: (runId) =>
            agentSessionTurnSubmittedEvent({
              ...identity,
              sessionRef: "session:s1",
              turnRef: "turn:s1:1",
              runtimeRunId: runId,
            }),
        },
      );

      expect(result.kind).toBe("start_with_product_link");
      expect(result.event.id).toBe(1);
      expect(result.productLink.payload.runtimeRunId).toBe(1);
      expect(committed.map((event) => event.kind)).toEqual([
        RUNTIME_EVENT_KIND.AGENT_RUN_STARTED,
        RUNTIME_EVENT_KIND.AGENT_SESSION_TURN_SUBMITTED,
      ]);
    }),
  );

  it.effect("fails closed when storage returns a non-runtime event for a runtime append", () =>
    Effect.gen(function* () {
      const event = agentRunStartedEvent({ ...identity, intent: "run" });
      const exit = yield* Effect.exit(
        appendRuntimeDriverAction(
          {
            commit: () =>
              Effect.succeed([
                decodeRecordedLedgerEvent({
                  ...eventFromSpec(1, event),
                  kind: "other.event",
                }),
              ]),
            commitPrepared: () => Effect.succeed([]),
          },
          { kind: "start", event },
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );
});
