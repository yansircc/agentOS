/**
 * Admission — submitAgent outputSchema end-to-end contract (contract §12.1).
 *
 * Two paths:
 *   1. outputSchema present + no tools → admission path; result.final is
 *      the decoded JSON, ledger holds chat.ingested + evidence + runtime terminal.
 *   2. outputSchema + non-empty tools → submit aborts with
 *      `output_schema_excludes_tools_in_v0_2_10` BEFORE any LLM call
 *      (mutual exclusivity invariant — contract §12.1).
 */

import { Effect, Exit, Schema } from "effect";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type {} from "@effect/vitest";

import { Ledger } from "../../src/ledger";
import { type InternalSubmitSpec, submitAgentEffect } from "@agent-os/runtime";
import { defineTool, pureToolExecution } from "@agent-os/kernel/tools";
import { stubLlmTransport } from "../_stub-ai";
import { allowToolAdmitter } from "../_tool-fixture";

import { SCHEMA, makeRuntime, submitStructuredResp } from "./_helpers";

interface TestEnv {
  readonly AGENT_DO: DurableObjectNamespace;
}
const testEnv = env as unknown as TestEnv;
const route = {
  kind: "openai-chat-compatible",
  endpointRef: "test-endpoint",
  credentialRef: "test-credential",
  modelId: "test-model",
} as const;

describe("admission — submitAgent outputSchema path (contract §12.1)", () => {
  it("outputSchema present → admission path; result.final is the decoded JSON", async () => {
    const scope = "submit-outputschema";
    const id = testEnv.AGENT_DO.idFromName(scope);
    const stub = testEnv.AGENT_DO.get(id);

    await runInDurableObject(stub, async (_inst, state) => {
      const llm = stubLlmTransport([submitStructuredResp('{"summary":"from-submit"}', "c1")]);
      const runtime = makeRuntime(state, llm);

      const spec: InternalSubmitSpec = {
        intent: "summarize",
        context: {},
        route,
        tools: {},
        outputSchema: SCHEMA,
        scope,
        scopeRef: { kind: "conversation", scopeId: scope },
        effectAuthorityRef: { authorityClass: "llm_route", authorityId: "submit-outputschema" },
      };

      const r = await runtime.runPromise(submitAgentEffect(spec));
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(JSON.parse(r.final)).toEqual({ summary: "from-submit" });
      }

      // Admission writes evidence; submit writes the runtime terminal fact.
      const events = await runtime.runPromise(
        Effect.gen(function* () {
          const l = yield* Ledger;
          return yield* l.events(scope);
        }),
      );
      const kinds = events.map((e) => e.kind);
      expect(kinds).toContain("chat.ingested");
      expect(kinds).toContain("llm.structured.evidence");
      expect(kinds).toContain("agent.run.completed");
      expect(kinds).not.toContain("structured.done");

      await runtime.dispose();
    });
  });

  it("outputSchema + non-empty tools → aborts with output_schema_excludes_tools_in_v0_2_10", async () => {
    const scope = "submit-outputschema-conflict";
    const id = testEnv.AGENT_DO.idFromName(scope);
    const stub = testEnv.AGENT_DO.get(id);

    await runInDurableObject(stub, async (_inst, state) => {
      const llm = stubLlmTransport([]); // no responses needed; submit aborts before any LLM call
      const runtime = makeRuntime(state, llm);

      const spec: InternalSubmitSpec = {
        intent: "x",
        context: {},
        route,
        tools: {
          someTool: defineTool({
            name: "someTool",
            description: "x",
            args: Schema.Struct({}),
            execute: async () => "y",
            admit: allowToolAdmitter,
            authority: "read",
            execution: pureToolExecution(),
          }),
        },
        outputSchema: SCHEMA,
        scope,
        scopeRef: { kind: "conversation", scopeId: scope },
        effectAuthorityRef: {
          authorityClass: "llm_route",
          authorityId: "submit-outputschema-conflict",
        },
      };

      const exit = await runtime.runPromiseExit(submitAgentEffect(spec));
      expect(Exit.isSuccess(exit)).toBe(true);
      if (Exit.isSuccess(exit)) {
        expect(exit.value.ok).toBe(false);
        if (!exit.value.ok) {
          expect(exit.value.reason).toBe("upstream_failure");
        }
      }

      // Confirm payload mentions the exclusivity reason.
      const events = await runtime.runPromise(
        Effect.gen(function* () {
          const l = yield* Ledger;
          return yield* l.events(scope);
        }),
      );
      const aborted = events.find((e) => e.kind === "agent.aborted.upstream_failure");
      expect(aborted).toBeDefined();
      if (aborted) {
        const p = aborted.payload as { reason?: string };
        expect(p.reason).toBe("output_schema_excludes_tools_in_v0_2_10");
      }

      await runtime.dispose();
    });
  });

  it("over token budget writes evidence plus budget abort, with no deliver or completed event", async () => {
    const scope = "submit-outputschema-token-budget";
    const id = testEnv.AGENT_DO.idFromName(scope);
    const stub = testEnv.AGENT_DO.get(id);

    await runInDurableObject(stub, async (_inst, state) => {
      const llm = stubLlmTransport([submitStructuredResp('{"summary":"over-budget"}', "c1")]);
      const runtime = makeRuntime(state, llm);

      const spec: InternalSubmitSpec = {
        intent: "summarize",
        context: {},
        route,
        tools: {},
        outputSchema: SCHEMA,
        budget: { tokens: 10 },
        scope,
        scopeRef: { kind: "conversation", scopeId: scope },
        effectAuthorityRef: {
          authorityClass: "llm_route",
          authorityId: "submit-outputschema-token-budget",
        },
      };

      const r = await runtime.runPromise(submitAgentEffect(spec));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("budget_tokens");

      const events = await runtime.runPromise(
        Effect.gen(function* () {
          const l = yield* Ledger;
          return yield* l.events(scope);
        }),
      );
      const kinds = events.map((event) => event.kind);
      expect(kinds).toContain("llm.structured.evidence");
      expect(kinds.filter((kind) => kind === "agent.aborted.budget_tokens")).toHaveLength(1);
      expect(kinds).not.toContain("structured.done");
      expect(kinds).not.toContain("agent.run.completed");

      await runtime.dispose();
    });
  });
});
