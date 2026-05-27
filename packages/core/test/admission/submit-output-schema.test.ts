/**
 * Admission — submitAgent outputSchema end-to-end contract (spec-25 §12.1).
 *
 * Two paths:
 *   1. outputSchema present + no tools → admission path; result.final is
 *      the decoded JSON, ledger holds chat.ingested + evidence + deliver.
 *   2. outputSchema + non-empty tools → submit aborts with
 *      `output_schema_excludes_tools_in_v0_2_10` BEFORE any LLM call
 *      (mutual exclusivity invariant — spec-25 §12.1).
 */

import { Effect, Exit } from "effect";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";

import { Ledger } from "../../src/ledger";
import { type InternalSubmitSpec, submitAgentEffect } from "../../src/submit-agent";
import { defineRegisteredTool } from "../../src/tools";
import { stubAi } from "../_stub-ai";

import { SCHEMA, makeRuntime, submitStructuredResp } from "./_helpers";

interface TestEnv {
  readonly AGENT_DO: DurableObjectNamespace;
}
const testEnv = env as unknown as TestEnv;

describe("admission — submitAgent outputSchema path (spec-25 §12.1)", () => {
  it("outputSchema present → admission path; result.final is the decoded JSON", async () => {
    const scope = "submit-outputschema";
    const id = testEnv.AGENT_DO.idFromName(scope);
    const stub = testEnv.AGENT_DO.get(id);

    await runInDurableObject(stub, async (_inst, state) => {
      const ai = stubAi([submitStructuredResp('{"summary":"from-submit"}', "c1")]);
      const runtime = makeRuntime(state, ai);

      const spec: InternalSubmitSpec = {
        intent: "summarize",
        context: {},
        route: { kind: "cf-ai-binding", modelId: "@cf/test/model" } as const,
        tools: {},
        outputSchema: SCHEMA,
        deliver: {
          scope,
          scopeRef: { kind: "conversation", scopeId: scope },
          event: "structured.done",
        },
      };

      const r = await runtime.runPromise(submitAgentEffect(spec));
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(JSON.parse(r.final)).toEqual({ summary: "from-submit" });
      }

      // Ledger should contain: chat.ingested + llm.structured.evidence + deliver event.
      const events = await runtime.runPromise(
        Effect.gen(function* () {
          const l = yield* Ledger;
          return yield* l.events(scope);
        }),
      );
      const kinds = events.map((e) => e.kind);
      expect(kinds).toContain("chat.ingested");
      expect(kinds).toContain("llm.structured.evidence");
      expect(kinds).toContain("structured.done");

      await runtime.dispose();
    });
  });

  it("outputSchema + non-empty tools → aborts with output_schema_excludes_tools_in_v0_2_10", async () => {
    const scope = "submit-outputschema-conflict";
    const id = testEnv.AGENT_DO.idFromName(scope);
    const stub = testEnv.AGENT_DO.get(id);

    await runInDurableObject(stub, async (_inst, state) => {
      const ai = stubAi([]); // no responses needed; submit aborts before any LLM call
      const runtime = makeRuntime(state, ai);

      const spec: InternalSubmitSpec = {
        intent: "x",
        context: {},
        route: { kind: "cf-ai-binding", modelId: "@cf/test/model" } as const,
        tools: {
          someTool: defineRegisteredTool({
            definition: {
              type: "function",
              function: {
                name: "someTool",
                description: "x",
                parameters: { type: "object", properties: {}, required: [] },
              },
            },
            execute: async () => "y",
            authorityClass: "read",
          }),
        },
        outputSchema: SCHEMA,
        deliver: {
          scope,
          scopeRef: { kind: "conversation", scopeId: scope },
          event: "structured.done",
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
});
