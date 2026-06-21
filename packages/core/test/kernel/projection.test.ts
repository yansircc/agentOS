import { describe, expect, it } from "vite-plus/test";

import * as kernel from "../../src";
import type { Live, ProjectionContext, ProjectionSink, ProjectionSpec } from "../../src";
import {
  ProjectionResult,
  checkProjectionSink,
  defineProjectionSpec,
  project,
  projectionOutputOrFail,
  runProjectionSink,
} from "../../src/projection";

type WordSummary = {
  readonly count: number;
  readonly first: string;
};

const wordSummaryProjection = defineProjectionSpec<ReadonlyArray<string>, WordSummary>({
  id: "docs.word-summary",
  version: 1,
  source: {
    kind: "file",
    ref: "docs/source.json",
    hash: "sha256:source",
  },
  project: (input, ctx) => {
    const first = input[0];
    if (first === undefined) {
      return ctx.failure("source_empty", [{ path: "/", message: "expected at least one word" }]);
    }
    return ProjectionResult.ok(ctx.provenance, { count: input.length, first });
  },
});

const sameSummary = (actual: WordSummary, expected: WordSummary): boolean =>
  actual.count === expected.count && actual.first === expected.first;

describe("projection engine", () => {
  it("derives a view with projection and source provenance", () => {
    expect(project(wordSummaryProjection, ["alpha", "beta"])).toEqual({
      _tag: "ok",
      output: {
        count: 2,
        first: "alpha",
      },
      provenance: {
        projection: {
          id: "docs.word-summary",
          version: 1,
        },
        source: {
          kind: "file",
          ref: "docs/source.json",
          hash: "sha256:source",
        },
      },
    });
  });

  it("fails closed without inventing fallback output", () => {
    expect(project(wordSummaryProjection, [])).toEqual({
      _tag: "failure",
      reason: "source_empty",
      provenance: {
        projection: {
          id: "docs.word-summary",
          version: 1,
        },
        source: {
          kind: "file",
          ref: "docs/source.json",
          hash: "sha256:source",
        },
      },
      issues: [{ path: "/", message: "expected at least one word" }],
    });
  });

  it("normalizes projector-owned provenance back to the spec-owned source", () => {
    const forged = defineProjectionSpec<unknown, WordSummary>({
      id: "docs.forged",
      version: 1,
      source: { kind: "file", ref: "docs/source.json" },
      project: () =>
        ({
          _tag: "ok",
          output: { count: 1, first: "safe" },
          provenance: {
            projection: { id: "docs.evil", version: 999 },
            source: { kind: "file", ref: "other-source.json" },
          },
          leaked: "not part of ProjectionOk",
        }) as unknown as ReturnType<ProjectionSpec<unknown, WordSummary>["project"]>,
    });

    expect(project(forged, {})).toEqual({
      _tag: "ok",
      output: { count: 1, first: "safe" },
      provenance: {
        projection: {
          id: "docs.forged",
          version: 1,
        },
        source: {
          kind: "file",
          ref: "docs/source.json",
        },
      },
    });
  });

  it("validates projection identity at definition time", () => {
    expect(() =>
      defineProjectionSpec({
        id: "",
        version: 1,
        source: { kind: "file", ref: "docs/source.json" },
        project: (_input: unknown, ctx) => ctx.ok({}),
      }),
    ).toThrow("projection id must be non-empty");

    expect(() =>
      defineProjectionSpec({
        id: "docs.invalid",
        version: 0,
        source: { kind: "file", ref: "docs/source.json" },
        project: (_input: unknown, ctx) => ctx.ok({}),
      }),
    ).toThrow("projection version must be a positive integer");

    expect(() =>
      defineProjectionSpec({
        id: "docs.invalid",
        version: 1,
        source: { kind: "", ref: "docs/source.json" },
        project: (_input: unknown, ctx) => ctx.ok({}),
      }),
    ).toThrow("projection source kind must be non-empty");

    expect(() =>
      defineProjectionSpec({
        id: "docs.invalid",
        version: 1,
        source: {
          kind: "file",
          ref: "docs/source.json",
          sources: [{ kind: "file", ref: "docs/other-source.json" }],
        },
        project: (_input: unknown, ctx) => ctx.ok({}),
      }),
    ).toThrow("projection source children require source-set kind");

    expect(() =>
      defineProjectionSpec({
        id: "docs.invalid",
        version: 1,
        source: { kind: "source-set", ref: "docs/source-set" },
        project: (_input: unknown, ctx) => ctx.ok({}),
      }),
    ).toThrow("projection source-set must include at least one source");
  });

  it("reports invalid projector returns as explicit failures", () => {
    const invalid = defineProjectionSpec<unknown, WordSummary>({
      id: "docs.invalid-return",
      version: 1,
      source: { kind: "file", ref: "docs/source.json" },
      project: () => null as unknown as ReturnType<ProjectionSpec<unknown, WordSummary>["project"]>,
    });

    expect(project(invalid, {})).toEqual({
      _tag: "failure",
      reason: "projection_result_invalid",
      provenance: {
        projection: {
          id: "docs.invalid-return",
          version: 1,
        },
        source: {
          kind: "file",
          ref: "docs/source.json",
        },
      },
    });
  });

  it("reports thrown and thenable projector results as explicit failures without causes", () => {
    const throwing = defineProjectionSpec<unknown, WordSummary>({
      id: "docs.throwing",
      version: 1,
      source: { kind: "file", ref: "docs/source.json" },
      project: () => {
        throw new Error("raw provider detail");
      },
    });

    const thenable = defineProjectionSpec<unknown, WordSummary>({
      id: "docs.thenable",
      version: 1,
      source: { kind: "file", ref: "docs/source.json" },
      project: () =>
        Promise.resolve({
          _tag: "ok",
          output: { count: 1, first: "async" },
          provenance: {
            projection: { id: "docs.thenable", version: 1 },
            source: { kind: "file", ref: "docs/source.json" },
          },
        }) as unknown as ReturnType<ProjectionSpec<unknown, WordSummary>["project"]>,
    });

    expect(project(throwing, {})).toEqual({
      _tag: "failure",
      reason: "projection_threw",
      provenance: {
        projection: {
          id: "docs.throwing",
          version: 1,
        },
        source: {
          kind: "file",
          ref: "docs/source.json",
        },
      },
    });
    expect("cause" in project(throwing, {})).toBe(false);

    expect(project(thenable, {})).toEqual({
      _tag: "failure",
      reason: "projection_returned_thenable",
      provenance: {
        projection: {
          id: "docs.thenable",
          version: 1,
        },
        source: {
          kind: "file",
          ref: "docs/source.json",
        },
      },
    });
  });

  it("checks sinks without writing and writes only stale derived output", async () => {
    let current: WordSummary | undefined = { count: 1, first: "alpha" };
    const writes: WordSummary[] = [];
    const sink: ProjectionSink<WordSummary> = {
      id: "docs/word-summary.json",
      read: () =>
        current === undefined ? { _tag: "missing" } : { _tag: "found", output: current },
      write: (output) => {
        writes.push(output);
        current = output;
      },
      equals: sameSummary,
    };

    expect(await checkProjectionSink(wordSummaryProjection, ["alpha"], sink)).toEqual({
      _tag: "current",
      result: project(wordSummaryProjection, ["alpha"]),
      actual: { count: 1, first: "alpha" },
    });
    expect(writes).toEqual([]);

    expect(await checkProjectionSink(wordSummaryProjection, ["beta", "gamma"], sink)).toEqual({
      _tag: "stale",
      result: project(wordSummaryProjection, ["beta", "gamma"]),
      expected: { count: 2, first: "beta" },
      actual: { _tag: "found", output: { count: 1, first: "alpha" } },
    });
    expect(writes).toEqual([]);

    expect(await runProjectionSink(wordSummaryProjection, ["beta", "gamma"], sink)).toEqual({
      _tag: "updated",
      result: project(wordSummaryProjection, ["beta", "gamma"]),
      previous: { _tag: "found", output: { count: 1, first: "alpha" } },
    });
    expect(writes).toEqual([{ count: 2, first: "beta" }]);

    expect(await runProjectionSink(wordSummaryProjection, ["beta", "gamma"], sink)).toEqual({
      _tag: "current",
      result: project(wordSummaryProjection, ["beta", "gamma"]),
      actual: { count: 2, first: "beta" },
    });
    expect(writes).toEqual([{ count: 2, first: "beta" }]);
  });

  it("does not write sinks when projection fails", async () => {
    const writes: WordSummary[] = [];
    const sink: ProjectionSink<WordSummary> = {
      id: "docs/word-summary.json",
      read: () => ({ _tag: "missing" }),
      write: (output) => {
        writes.push(output);
      },
    };

    expect(await runProjectionSink(wordSummaryProjection, [], sink)).toEqual({
      _tag: "projection_failed",
      result: project(wordSummaryProjection, []),
    });
    expect(writes).toEqual([]);
  });

  it("unwraps projection output through a fail-fast DTO facade", () => {
    expect(projectionOutputOrFail(project(wordSummaryProjection, ["alpha"]))).toEqual({
      count: 1,
      first: "alpha",
    });
    expect(() => projectionOutputOrFail(project(wordSummaryProjection, []))).toThrow(
      "source_empty",
    );
  });

  it("does not expose provider, ledger mutation, or Live opening in projection context", () => {
    const live = undefined as unknown as Live<{ readonly secret: string }>;
    const context = undefined as unknown as ProjectionContext;

    const assertTypeErrors = () => {
      const asyncProjector: ProjectionSpec<unknown, WordSummary> = {
        id: "docs.async",
        version: 1,
        source: { kind: "file", ref: "docs/source.json" },
        // @ts-expect-error Projection functions must be synchronous.
        project: async () => ProjectionResult.ok(context.provenance, { count: 1, first: "x" }),
      };
      // @ts-expect-error ProjectionContext has no provider resolver surface.
      const provider = context.resolveProvider;
      // @ts-expect-error ProjectionContext has no ledger append surface.
      const append = context.appendLedgerEvent;
      // @ts-expect-error ProjectionContext has no Live opener.
      const open = context.openLive(live);
      // @ts-expect-error ProjectionFailure carries no raw cause.
      const cause = project(wordSummaryProjection, []).cause;
      return [asyncProjector, provider, append, open, cause];
    };

    expect(typeof assertTypeErrors).toBe("function");
    expect("openLive" in kernel).toBe(false);
    expect("captureLive" in kernel).toBe(false);
  });
});
