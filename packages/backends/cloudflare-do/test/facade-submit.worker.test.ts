import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";

import { credentialMaterialRef } from "@agent-os/kernel/material-ref";
import { defineAgentSubmitBindings } from "@agent-os/runtime-protocol";
import { facadeApply, facadeIntent, facadeLookup, type FacadeSubmitTestDO } from "./test-worker";
import { testTruthIdentity } from "./_identity";

interface TestEnv {
  readonly FACADE_SUBMIT_DO: DurableObjectNamespace<FacadeSubmitTestDO>;
}

const testEnv = env as unknown as TestEnv;

describe("defineAgentDO facade submit", () => {
  it("uses llms.default and run-scoped tools through the explicit transport binding", async () => {
    const scope = "facade-submit-defaults";
    const stub = testEnv.FACADE_SUBMIT_DO.get(testEnv.FACADE_SUBMIT_DO.idFromName(scope));
    const effectAuthorityRef = {
      authorityClass: "llm_route" as const,
      authorityId: "facade-submit-test",
    };

    const result = await runInDurableObject(stub, (instance) =>
      instance.submit({
        intent: "lookup",
        input: { key: "abc" },
        effectAuthorityRef,
        bindings: defineAgentSubmitBindings({
          tools: { lookup: facadeLookup },
          context: { input: { key: "abc" }, source: "run-binding" },
        }),
        budget: { maxTurns: 1 },
      }),
    );

    const events = await (
      stub as unknown as {
        readonly events: (
          identity: ReturnType<typeof testTruthIdentity>,
        ) => Promise<ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>>;
      }
    ).events(testTruthIdentity(scope, effectAuthorityRef));

    expect(result.ok, JSON.stringify({ result, events })).toBe(true);
    if (result.ok) {
      expect(result.final).toBe("facade done");
      expect(result.tokensUsed).toBe(7);
    }

    const completed = events.filter((event) => event.kind === "agent.run.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]?.payload).toEqual({
      runId: 1,
      final: "facade done",
      output: "facade done",
      outputKind: "text",
      tokensUsed: 7,
      turn: { id: 1, index: 0 },
    });
    expect(events.some((event) => event.kind === "test.delivered")).toBe(false);
  });

  it("passes run-scoped material refs and resolved material values through submit bindings", async () => {
    const scope = "facade-submit-material-bindings";
    const stub = testEnv.FACADE_SUBMIT_DO.get(testEnv.FACADE_SUBMIT_DO.idFromName(scope));
    const effectAuthorityRef = {
      authorityClass: "llm_route" as const,
      authorityId: "facade-submit-material-test",
    };
    const tokenRef = credentialMaterialRef("facade-run-token", {
      provider: "facade",
      purpose: "apply",
    });

    const result = await runInDurableObject(stub, (instance) =>
      instance.submit({
        intent: "apply",
        input: { key: "abc" },
        effectAuthorityRef,
        bindings: defineAgentSubmitBindings({
          tools: { apply: facadeApply },
          materials: { facade_token: tokenRef },
          resolvedMaterials: {
            facade_token: "facade-secret-that-must-stay-out-of-ledger-and-llm-requests",
          },
        }),
        budget: { maxTurns: 2 },
      }),
    );

    const events = await (
      stub as unknown as {
        readonly events: (
          identity: ReturnType<typeof testTruthIdentity>,
        ) => Promise<ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>>;
      }
    ).events(testTruthIdentity(scope, effectAuthorityRef));

    expect(result.ok, JSON.stringify({ result, events })).toBe(true);
    const toolExecuted = events.find((event) => event.kind === "tool.executed");
    expect(toolExecuted?.payload).toMatchObject({
      result: { materialMatched: true },
    });
    expect(JSON.stringify(events)).not.toContain(
      "facade-secret-that-must-stay-out-of-ledger-and-llm-requests",
    );
  });

  it("passes decision interrupts through submit bindings before tool execution", async () => {
    const scope = "facade-submit-decision-interrupts";
    const stub = testEnv.FACADE_SUBMIT_DO.get(testEnv.FACADE_SUBMIT_DO.idFromName(scope));
    const effectAuthorityRef = {
      authorityClass: "llm_route" as const,
      authorityId: "facade-submit-decision-test",
    };

    const result = await runInDurableObject(stub, (instance) =>
      instance.submit({
        intent: "apply",
        input: { key: "abc" },
        effectAuthorityRef,
        bindings: defineAgentSubmitBindings({
          tools: { apply: facadeApply },
          decisionInterrupts: [{ toolName: "apply", reason: "approval_required" }],
        }),
        budget: { maxTurns: 1 },
      }),
    );

    const events = await (
      stub as unknown as {
        readonly events: (
          identity: ReturnType<typeof testTruthIdentity>,
        ) => Promise<ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>>;
      }
    ).events(testTruthIdentity(scope, effectAuthorityRef));

    expect(result).toMatchObject({
      ok: false,
      status: "interrupted",
      reason: "interrupted",
    });
    expect(events.some((event) => event.kind === "agent.run.interrupted")).toBe(true);
    expect(events.some((event) => event.kind === "tool.executed")).toBe(false);
  });

  it("passes declared intent emission and projection wait capabilities to run-scoped tools", async () => {
    const scope = "facade-submit-tool-context-capabilities";
    const stub = testEnv.FACADE_SUBMIT_DO.get(testEnv.FACADE_SUBMIT_DO.idFromName(scope));
    const effectAuthorityRef = {
      authorityClass: "llm_route" as const,
      authorityId: "facade-submit-intent-test",
    };

    const result = await runInDurableObject(stub, (instance) =>
      instance.submit({
        intent: "intent",
        input: { label: "abc" },
        effectAuthorityRef,
        bindings: defineAgentSubmitBindings({
          tools: { intent: facadeIntent },
        }),
        budget: { maxTurns: 2 },
      }),
    );

    const events = await (
      stub as unknown as {
        readonly events: (
          identity: ReturnType<typeof testTruthIdentity>,
        ) => Promise<ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>>;
      }
    ).events(testTruthIdentity(scope, effectAuthorityRef));

    expect(result.ok, JSON.stringify({ result, events })).toBe(true);
    if (result.ok) {
      expect(result.final).toBe("facade intent done");
    }
    expect(events.some((event) => event.kind === "facade.intent.requested")).toBe(true);
    expect(events.find((event) => event.kind === "tool.executed")?.payload).toMatchObject({
      result: { projectedState: { label: "abc" } },
    });
  });
});
