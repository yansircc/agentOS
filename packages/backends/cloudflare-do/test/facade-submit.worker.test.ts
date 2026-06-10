import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";

import { credentialMaterialRef } from "@agent-os/kernel/material-ref";
import { defineAgentSubmitBindings } from "@agent-os/runtime-protocol";
import { facadeApply, facadeLookup, type FacadeSubmitTestDO } from "./test-worker";
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
          handlers: {},
          tools: { lookup: facadeLookup },
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

  it("passes run-scoped material refs through submit bindings into runtime resolution", async () => {
    const scope = "facade-submit-material-bindings";
    const stub = testEnv.FACADE_SUBMIT_DO.get(testEnv.FACADE_SUBMIT_DO.idFromName(scope));
    const effectAuthorityRef = {
      authorityClass: "llm_route" as const,
      authorityId: "facade-submit-material-test",
    };
    const tokenRef = credentialMaterialRef("facade-token", {
      provider: "facade",
      purpose: "apply",
    });

    const result = await runInDurableObject(stub, (instance) =>
      instance.submit({
        intent: "apply",
        input: { key: "abc" },
        effectAuthorityRef,
        bindings: defineAgentSubmitBindings({
          handlers: {},
          tools: { apply: facadeApply },
          materials: { facade_token: tokenRef },
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
});
