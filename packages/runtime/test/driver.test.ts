import { Effect, Exit } from "effect";
import { describe, expect, it } from "@effect/vitest";
import type { Recorded } from "@agent-os/kernel";
import type { LedgerEvent } from "@agent-os/kernel/types";
import {
  RUNTIME_EVENT_KIND,
  agentRunStartedEvent,
  type RuntimeEventCommitSpec,
} from "@agent-os/runtime-protocol";
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

describe("runtime driver value-domain boundary", () => {
  it.effect("returns decoded Recorded runtime events from driver appends", () =>
    Effect.gen(function* () {
      const event = agentRunStartedEvent({ ...identity, intent: "run" });
      const result = yield* appendRuntimeDriverAction(
        {
          commit: (specs) =>
            Effect.succeed(
              specs.map((spec, index) => eventFromSpec(index + 1, spec as RuntimeEventCommitSpec)),
            ),
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

  it.effect("fails closed when storage returns a non-runtime event for a runtime append", () =>
    Effect.gen(function* () {
      const event = agentRunStartedEvent({ ...identity, intent: "run" });
      const exit = yield* Effect.exit(
        appendRuntimeDriverAction(
          {
            commit: () =>
              Effect.succeed([
                {
                  ...eventFromSpec(1, event),
                  kind: "other.event",
                },
              ]),
          },
          { kind: "start", event },
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );
});
