import { describe, expect, it } from "@effect/vitest";
import type { SubmitSpec } from "@agent-os/runtime-protocol";
import { internalSubmitSpec, type InternalSubmitSpec } from "../src/internal-submit";

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
