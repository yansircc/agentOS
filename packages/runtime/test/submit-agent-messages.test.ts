import { Effect } from "effect";
import { describe, expect, it } from "@effect/vitest";

import { buildInitialMessages } from "../src/submit-agent";

const context = { topic: "ROVs", priorTurns: [] };

describe("submit agent initial messages", () => {
  it.effect("uses supplied system as the behavior program and keeps context in system", () =>
    Effect.gen(function* () {
      const customSystem =
        "You are an interview agent for writers. Follow EEAT discipline. Output Chinese questions.";

      const messages = yield* buildInitialMessages({
        intent: "Conduct one interview turn.",
        context,
        system: customSystem,
      });

      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({
        role: "system",
      });
      expect(messages[0]?.content?.startsWith(customSystem)).toBe(true);
      expect(messages[0]?.content?.includes("You are an agent. Goal:")).toBe(false);
      expect(messages[0]?.content?.includes("Context available:")).toBe(true);
      expect(messages[1]).toEqual({
        role: "user",
        content: "Conduct one interview turn.",
      });
    }),
  );

  it.effect("uses the default wrapper when system is absent", () =>
    Effect.gen(function* () {
      const messages = yield* buildInitialMessages({
        intent: "Conduct one interview turn.",
        context,
      });

      expect(messages[0]?.role).toBe("system");
      expect(
        messages[0]?.content?.startsWith("You are an agent. Goal: Conduct one interview turn."),
      ).toBe(true);
      expect(messages[0]?.content?.includes("Use the provided tools")).toBe(true);
      expect(messages[1]).toEqual({
        role: "user",
        content: "Conduct one interview turn.",
      });
    }),
  );

  it.effect("always uses intent as the user message", () =>
    Effect.gen(function* () {
      const intent = "Specific task input #42";
      const withSystem = yield* buildInitialMessages({
        intent,
        context,
        system: "Behavior program text",
      });
      const withoutSystem = yield* buildInitialMessages({
        intent,
        context,
      });

      expect(withSystem[1]).toEqual({ role: "user", content: intent });
      expect(withoutSystem[1]).toEqual({ role: "user", content: intent });
    }),
  );
});
