import { Effect, Exit } from "effect";
import { describe, expect, it } from "@effect/vitest";
import {
  attachedStreamParseOk,
  makeAttachedStreamRegistry,
  runSynchronousAttachedStreamCommit,
  type AttachedStreamHandler,
} from "../src/attached-stream";

const handler = (kind: string): AttachedStreamHandler<unknown, { readonly ok: true }> => ({
  kind,
  mode: "bidi",
  cancellation: "cooperative",
  onDetach: "abort",
  parseStart: (raw) => attachedStreamParseOk(raw),
  run: async function* () {
    yield { kind: "completed", terminal: { ok: true } };
  },
  commitTerminal: () => undefined,
});

describe("attached stream runtime algebra", () => {
  it.effect("rejects missing explicit handler declarations", () =>
    Effect.gen(function* () {
      const valid = handler("required-fields");
      for (const field of ["mode", "cancellation", "onDetach", "commitTerminal"] as const) {
        const incomplete = { ...valid };
        delete (incomplete as Record<string, unknown>)[field];
        const either = yield* Effect.either(
          makeAttachedStreamRegistry([
            incomplete as unknown as AttachedStreamHandler<unknown, unknown>,
          ]),
        );
        expect(either).toMatchObject({
          _tag: "Left",
          left: expect.stringContaining(field),
        });
      }
    }),
  );

  it.effect("rejects duplicate and durable-trigger-conflicting stream kinds", () =>
    Effect.gen(function* () {
      const duplicate = yield* Effect.exit(
        makeAttachedStreamRegistry([handler("x"), handler("x")]),
      );
      expect(Exit.isFailure(duplicate)).toBe(true);

      const conflict = yield* Effect.either(
        makeAttachedStreamRegistry([handler("trigger.kind")], {
          reservedKinds: ["trigger.kind"],
        }),
      );
      expect(conflict).toMatchObject({
        _tag: "Left",
        left: expect.stringContaining("conflicts with durable trigger"),
      });
    }),
  );

  it("guards terminal commits against thenables", () => {
    expect(runSynchronousAttachedStreamCommit("scope", "kind", () => Promise.resolve())).toContain(
      "returned a thenable",
    );
    expect(runSynchronousAttachedStreamCommit("scope", "kind", () => undefined)).toBeNull();
  });
});
