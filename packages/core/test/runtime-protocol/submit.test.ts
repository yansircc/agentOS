import { describe, expect, it } from "@effect/vitest";
import {
  lowerSubmitRunInput,
  type SubmitRunInput,
  type SubmitSpec,
  type SubmitToolPolicy,
  type SubmitToolRetryPolicy,
} from "../../src/runtime-protocol";

const route = {
  kind: "openai-chat-compatible" as const,
  endpointRef: "test-endpoint",
  credentialRef: "test-credential",
  modelId: "test-model",
};

const effectAuthorityRef = {
  authorityClass: "llm_route" as const,
  authorityId: "test-route",
};

const toolRetryPolicy = {
  correctionRetries: 1,
  execution: {
    maxRetries: 2,
    delay: { kind: "fixed" as const, delayMs: 250, jitter: false },
  },
} satisfies SubmitToolRetryPolicy;

const toolPolicy = {
  completeAfterToolsExecuted: {
    invocation: "required",
    toolNames: ["write_terminal"],
    finalMessage: "done",
  },
} satisfies SubmitToolPolicy;

const input = (): SubmitRunInput => ({
  intent: "answer",
  context: { topic: "submit-lowering" },
});

describe("submit lowering", () => {
  it("preserves runtime policy values while erasing non-contract budget fields", () => {
    const smuggledInput = {
      ...input(),
      budget: {
        maxTurns: 4,
        toolRetryPolicy,
        toolRetries: 99,
      },
      toolPolicy,
    } as SubmitRunInput & {
      readonly budget: NonNullable<SubmitRunInput["budget"]> & { readonly toolRetries: number };
    };

    const spec = lowerSubmitRunInput({
      input: smuggledInput,
      bindings: { llmRoutes: { default: route } },
      effectAuthorityRef,
    });

    expect(spec).toMatchObject({
      intent: "answer",
      context: { topic: "submit-lowering" },
      route,
      effectAuthorityRef,
      toolPolicy,
    } satisfies Partial<SubmitSpec>);
    expect(spec.budget).toEqual({
      maxTurns: 4,
      toolRetryPolicy,
    });
    expect("toolRetries" in spec.budget!).toBe(false);
  });

  it("merges binding decision floors before run-scoped decision interrupts", () => {
    const spec = lowerSubmitRunInput({
      input: {
        ...input(),
        decisionInterrupts: [
          { toolName: "publish", reason: "authorization_required" },
          { toolName: "notify", reason: "user_input_required" },
        ],
      },
      bindings: {
        llmRoutes: { default: route },
        decisionInterrupts: [{ toolName: "publish", reason: "approval_required" }],
      },
      effectAuthorityRef,
    });

    expect(spec.decisionInterrupts).toEqual([
      { toolName: "publish", reason: "approval_required" },
      { toolName: "notify", reason: "user_input_required" },
    ]);
  });
});
