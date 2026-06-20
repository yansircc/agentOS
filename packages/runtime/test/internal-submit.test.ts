import { describe, expect, it } from "@effect/vitest";
import { EXECUTION_IDENTITY_VERSION, type SubmitSpec } from "@agent-os/runtime-protocol";
import { internalSubmitSpec, type InternalSubmitSpec } from "../src/internal-submit";

const executionIdentity = {
  version: EXECUTION_IDENTITY_VERSION,
  manifest: { agentId: "agent.internal-submit", version: "1.0.0" },
  deployment: {
    deploymentId: "deployment:internal-submit",
    backend: "in-memory",
    adapter: "runtime-test",
    codec: "ledger-v1",
  },
} satisfies NonNullable<SubmitSpec["executionIdentity"]>;

const publicSpec = (): SubmitSpec => ({
  intent: "answer",
  context: { topic: "internal-submit" },
  route: {
    kind: "openai-chat-compatible",
    endpointRef: "test-endpoint",
    credentialRef: "test-credential",
    modelId: "test-model",
  },
  tools: {},
  effectAuthorityRef: { authorityClass: "llm_route", authorityId: "test-route" },
});

const toolRetryPolicy = {
  correctionRetries: 1,
  execution: {
    maxRetries: 2,
    delay: { kind: "fixed" as const, delayMs: 250, jitter: false },
  },
};

const toolPolicy = {
  completeAfterToolsExecuted: {
    toolNames: ["write_terminal"],
    finalMessage: "done",
  },
};

describe("internalSubmitSpec", () => {
  it("rebuilds internal submit from the public allowlist", () => {
    const spec = internalSubmitSpec(publicSpec(), {
      scope: "scope-1",
      scopeRef: { kind: "conversation", scopeId: "scope-1" },
    });

    expect(spec).toMatchObject({
      intent: "answer",
      context: { topic: "internal-submit" },
      scope: "scope-1",
      scopeRef: { kind: "conversation", scopeId: "scope-1" },
    });
  });

  it("does not copy caller-provided internal fields", () => {
    const smuggled = {
      ...publicSpec(),
      resolvedMaterials: { wp_token: "attacker-material" },
    } as SubmitSpec & { readonly resolvedMaterials: unknown };

    const spec = internalSubmitSpec(smuggled, {
      scope: "scope-1",
      scopeRef: { kind: "conversation", scopeId: "scope-1" },
    });

    expect("resolvedMaterials" in spec).toBe(false);
  });

  it("rebuilds policy-bearing budget from the SubmitSpec allowlist", () => {
    const smuggled = {
      ...publicSpec(),
      budget: {
        maxTurns: 4,
        toolRetryPolicy,
        toolRetries: 99,
      },
      toolPolicy,
    } as SubmitSpec & {
      readonly budget: NonNullable<SubmitSpec["budget"]> & { readonly toolRetries: number };
    };

    const spec = internalSubmitSpec(smuggled, {
      scope: "scope-1",
      scopeRef: { kind: "conversation", scopeId: "scope-1" },
    });

    expect(spec.budget).toEqual({
      maxTurns: 4,
      toolRetryPolicy,
    });
    expect("toolRetries" in spec.budget!).toBe(false);
    expect(spec.toolPolicy).toEqual(toolPolicy);
  });

  it("preserves execution identity as runtime evidence", () => {
    const spec = internalSubmitSpec(
      { ...publicSpec(), executionIdentity },
      {
        scope: "scope-1",
        scopeRef: { kind: "conversation", scopeId: "scope-1" },
      },
    );

    expect(spec.executionIdentity).toEqual(executionIdentity);
  });

  it("keeps internal submit construction sealed to the constructor", () => {
    // @ts-expect-error InternalSubmitSpec is intentionally opaque; callers must use internalSubmitSpec().
    const literal: InternalSubmitSpec = {
      ...publicSpec(),
      scope: "scope-1",
      scopeRef: { kind: "conversation", scopeId: "scope-1" },
    };
    expect(literal.scope).toBe("scope-1");
  });
});
