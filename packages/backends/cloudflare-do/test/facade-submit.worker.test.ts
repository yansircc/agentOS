import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type {} from "@effect/vitest";

import { credentialMaterialRef } from "@agent-os/kernel/material-ref";
import {
  FACADE_INTENT_COMMAND_EVENT,
  type FacadeSubmitTestDO,
} from "./test-worker";
import { testTruthIdentity } from "./_identity";

interface TestEnv {
  readonly FACADE_SUBMIT_DO: DurableObjectNamespace<FacadeSubmitTestDO>;
}

const testEnv = env as unknown as TestEnv;
const facadeSubmitAuthorityRef = {
  authorityClass: "llm_route" as const,
  authorityId: "default",
};

describe("defineAgentDO facade submit", () => {
  it("uses llms.default and run-scoped tools through the explicit transport binding", async () => {
    const scope = "facade-submit-defaults";
    const stub = testEnv.FACADE_SUBMIT_DO.get(testEnv.FACADE_SUBMIT_DO.idFromName(scope));

    const result = await runInDurableObject(stub, (instance) =>
      instance.submit({
        intent: "lookup",
        input: { key: "abc" },
        context: { input: { key: "abc" }, source: "run-input" },
        budget: { maxTurns: 1 },
      }),
    );

    const events = await (
      stub as unknown as {
        readonly events: (
          identity: ReturnType<typeof testTruthIdentity>,
        ) => Promise<ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>>;
      }
    ).events(testTruthIdentity(scope, facadeSubmitAuthorityRef));

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

  it("passes run-scoped material refs through submit bindings and resolves them server-side", async () => {
    const scope = "facade-submit-material-bindings";
    const stub = testEnv.FACADE_SUBMIT_DO.get(testEnv.FACADE_SUBMIT_DO.idFromName(scope));
    const tokenRef = credentialMaterialRef("facade-token", {
      provider: "facade",
      purpose: "apply",
    });

    const result = await runInDurableObject(stub, (instance) =>
      instance.submit({
        intent: "apply",
        input: { key: "abc" },
        materials: { facade_token: tokenRef },
        budget: { maxTurns: 2 },
      }),
    );

    const events = await (
      stub as unknown as {
        readonly events: (
          identity: ReturnType<typeof testTruthIdentity>,
        ) => Promise<ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>>;
      }
    ).events(testTruthIdentity(scope, facadeSubmitAuthorityRef));

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

    const result = await runInDurableObject(stub, (instance) =>
      instance.submit({
        intent: "apply",
        input: { key: "abc" },
        decisionInterrupts: [{ toolName: "apply", reason: "approval_required" }],
        budget: { maxTurns: 1 },
      }),
    );

    const events = await (
      stub as unknown as {
        readonly events: (
          identity: ReturnType<typeof testTruthIdentity>,
        ) => Promise<ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>>;
      }
    ).events(testTruthIdentity(scope, facadeSubmitAuthorityRef));

    expect(result).toMatchObject({
      ok: false,
      status: "interrupted",
      reason: "interrupted",
    });
    expect(events.some((event) => event.kind === "agent.run.interrupted")).toBe(true);
    expect(events.some((event) => event.kind === "tool.executed")).toBe(false);
  });

  it("passes submit tool policy through facade lowering", async () => {
    const scope = "facade-submit-tool-policy";
    const stub = testEnv.FACADE_SUBMIT_DO.get(testEnv.FACADE_SUBMIT_DO.idFromName(scope));

    const result = await runInDurableObject(stub, (instance) =>
      instance.submit({
        intent: "write artifacts",
        input: {},
        toolPolicy: {
          completeAfterToolsExecuted: {
            toolNames: ["write_first", "write_second"],
            finalMessage: "facade artifacts written",
          },
        },
        budget: { maxTurns: 5 },
      }),
    );

    const events = await (
      stub as unknown as {
        readonly events: (
          identity: ReturnType<typeof testTruthIdentity>,
        ) => Promise<ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>>;
      }
    ).events(testTruthIdentity(scope, facadeSubmitAuthorityRef));

    expect(result).toMatchObject({
      ok: true,
      final: "facade artifacts written",
    });
    expect(events.filter((event) => event.kind === "llm.response")).toHaveLength(2);
    expect(
      events
        .filter((event) => event.kind === "tool.executed")
        .map((event) =>
          typeof event.payload === "object" && event.payload !== null
            ? (event.payload as { readonly name?: string }).name
            : null,
        ),
    ).toEqual(["write_first", "write_second"]);
  });

  it("passes declared intent emission and projection wait capabilities to run-scoped tools", async () => {
    const scope = "facade-submit-tool-context-capabilities";
    const stub = testEnv.FACADE_SUBMIT_DO.get(testEnv.FACADE_SUBMIT_DO.idFromName(scope));

    const result = await runInDurableObject(stub, (instance) =>
      instance.submit({
        intent: "intent",
        input: { label: "abc" },
        budget: { maxTurns: 2 },
      }),
    );

    const events = await (
      stub as unknown as {
        readonly events: (
          identity: ReturnType<typeof testTruthIdentity>,
        ) => Promise<ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>>;
      }
    ).events(testTruthIdentity(scope, facadeSubmitAuthorityRef));

    expect(result.ok, JSON.stringify({ result, events })).toBe(true);
    if (result.ok) {
      expect(result.final).toBe("facade intent done");
    }
    expect(events.some((event) => event.kind === "facade.intent.requested")).toBe(true);
    expect(events.find((event) => event.kind === "tool.executed")?.payload).toMatchObject({
      result: { projectedState: { label: "abc" } },
    });
  });

  it("lets facade on handlers commit boundary facts through extension capabilities", async () => {
    const scope = "facade-on-boundary-capability";
    const stub = testEnv.FACADE_SUBMIT_DO.get(testEnv.FACADE_SUBMIT_DO.idFromName(scope));

    await runInDurableObject(stub, async (instance) => {
      await expect(
        instance.emit("facade.intent.requested", { label: "direct" }),
      ).rejects.toMatchObject({
        _tag: "agent_os.capability_rejected",
        event: "facade.intent.requested",
      });

      await instance.emit(FACADE_INTENT_COMMAND_EVENT, { label: "from-handler" });
    });

    const events = await (
      stub as unknown as {
        readonly events: (identity: ReturnType<typeof testTruthIdentity>) => Promise<
          ReadonlyArray<{
            readonly kind: string;
            readonly factOwnerRef: string;
            readonly payload: unknown;
          }>
        >;
      }
    ).events(testTruthIdentity(scope));

    const requested = events.find((event) => event.kind === "facade.intent.requested");
    expect(requested).toMatchObject({
      factOwnerRef: "@agent-os/facade-intent-test",
      payload: { label: "from-handler" },
    });
    expect(events.filter((event) => event.kind === "facade.intent.requested")).toHaveLength(1);
  });
});
