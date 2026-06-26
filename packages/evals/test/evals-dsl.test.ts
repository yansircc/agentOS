import { describe, expect, it } from "vitest";
import {
  defineEval,
  defineEvalConfig,
  defineEvalDataset,
  evalAssertion,
  evalIdFromPath,
} from "../src/index";

describe("@agent-os/evals DSL", () => {
  it("derives stable ids from eval file paths", () => {
    expect(evalIdFromPath("/repo/evals/session/basic.eval.ts", { root: "/repo" })).toBe(
      "session.basic",
    );
    expect(evalIdFromPath("evals/workflow/build-flow.eval.ts")).toBe("workflow.build-flow");
    expect(evalIdFromPath("evals\\channels\\sms.eval.ts")).toBe("channels.sms");
  });

  it("normalizes datasets without a runtime dependency", () => {
    const dataset = defineEvalDataset([
      { input: { prompt: "ship" }, tags: ["happy"] },
      { id: "custom", input: { prompt: "wait" }, metadata: { owner: "eval" } },
    ]);

    expect(dataset).toEqual([
      { id: "case-1", input: { prompt: "ship" }, tags: ["happy"], metadata: {} },
      { id: "custom", input: { prompt: "wait" }, tags: [], metadata: { owner: "eval" } },
    ]);
    expect(Object.isFrozen(dataset)).toBe(true);
    expect(Object.isFrozen(dataset[0])).toBe(true);
  });

  it("defines evals as frozen authoring declarations", async () => {
    const run = async () => "ok";
    const definition = defineEval({
      path: "/repo/evals/session/basic.eval.ts",
      title: "basic session",
      tags: ["session"],
      cases: [{ input: "hello" }],
      assertions: [evalAssertion.completed()],
      run,
    });

    expect(definition.id).toBe("session.basic");
    expect(definition.cases[0]?.id).toBe("case-1");
    expect(definition.assertions).toEqual([{ kind: "completed" }]);
    expect(await definition.run?.({} as never)).toBe("ok");
    expect(Object.isFrozen(definition)).toBe(true);
  });

  it("keeps provider needs symbolic in config", () => {
    const config = defineEvalConfig({
      target: {
        kind: "remote",
        baseUrl: "https://example.invalid",
        headers: { authorization: "Bearer test" },
      },
      providers: [
        {
          id: "judge",
          kind: "model",
          provider: "openai-compatible",
          model: "eval-model",
          purpose: "judge",
        },
        {
          id: "scripted",
          kind: "scripted",
          metadata: { fixture: "ok" },
        },
      ],
      reporters: [{ kind: "summary" }],
      timeoutMs: 1_000,
    });

    expect(config).toEqual({
      target: {
        kind: "remote",
        baseUrl: "https://example.invalid",
        headers: { authorization: "Bearer test" },
      },
      providers: [
        {
          id: "judge",
          kind: "model",
          provider: "openai-compatible",
          model: "eval-model",
          purpose: "judge",
          metadata: {},
        },
        { id: "scripted", kind: "scripted", metadata: { fixture: "ok" } },
      ],
      reporters: [{ kind: "summary" }],
      timeoutMs: 1_000,
    });
  });

  it("builds deterministic assertion declarations", async () => {
    const check = async () => true;
    expect(evalAssertion.completed()).toEqual({ kind: "completed" });
    expect(evalAssertion.waiting()).toEqual({ kind: "waiting" });
    expect(evalAssertion.failed("boom")).toEqual({ kind: "failed", reason: "boom" });
    expect(evalAssertion.calledTool("search")).toEqual({
      kind: "called_tool",
      toolName: "search",
    });
    expect(evalAssertion.notCalledTool("delete")).toEqual({
      kind: "not_called_tool",
      toolName: "delete",
    });
    expect(evalAssertion.usedNoTools()).toEqual({ kind: "used_no_tools" });
    expect(evalAssertion.projection("sessions")).toEqual({
      kind: "projection",
      name: "sessions",
    });
    const custom = evalAssertion.check("custom", check);
    expect(custom).toMatchObject({ kind: "check", name: "custom" });
    if (custom.kind !== "check") throw new Error("expected check assertion");
    await expect(custom.check({ events: [], projections: new Map() })).resolves.toBe(true);
  });
});
