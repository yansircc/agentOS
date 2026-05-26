/**
 * Admission — IO contract tests (spec-25 §2, §10).
 *
 * Three test groups:
 *   1. attemptStructured IO contract: closed-schema rejection, atomic
 *      evidence + deliver write, lease short-circuit, barrier reset.
 *   2. Malformed payload defense (Codex P2): infra corruption MUST
 *      surface as SqlError, not a `TypeError: undefined is not an
 *      object` leak out of projectLease.
 *   3. Cross-route structured-output dispatch (v0.2.13): structured
 *      output dispatches on `route.kind` exactly like free-text submit;
 *      AiBinding sentinel proves the openai-chat-compatible route does
 *      NOT touch the cf-ai-binding transport.
 */

import { Cause, Effect, Exit, Option } from "effect";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Ledger } from "../../src/ledger";
import {
  ADAPTER_VERSION,
  Admission,
  type JsonSchemaObject,
  makeSchemaContract,
  routeFingerprint,
} from "../../src/admission";
import {
  type InternalSubmitSpec,
  submitAgentEffect,
} from "../../src/submit-agent";
import { stubAi } from "../_stub-ai";

import {
  SCHEMA,
  makeRuntime,
  makeRuntimeWithRegistry,
  submitStructuredResp,
} from "./_helpers";

interface TestEnv {
  readonly AGENT_DO: DurableObjectNamespace;
}
const testEnv = env as unknown as TestEnv;

// ============================================================
// IO contract: attemptStructured
// ============================================================

describe("admission — IO contract: attemptStructured", () => {
  it("additionalProperties:false rejects extra keys → BehaviorFailed", async () => {
    const scope = "admission-closed-schema";
    const id = testEnv.AGENT_DO.idFromName(scope);
    const stub = testEnv.AGENT_DO.get(id);

    await runInDurableObject(stub, async (_inst, state) => {
      // LLM returns valid `summary` + an extra `extra` key. With
      // additionalProperties:false the decoder MUST reject this as
      // BehaviorFailed (Codex P1: prior implementation silently passed).
      const ai = stubAi([
        submitStructuredResp(
          JSON.stringify({ summary: "ok", extra: "should-be-rejected" }),
          "c1",
        ),
      ]);
      const runtime = makeRuntime(state, ai);

      const closedSchema: JsonSchemaObject = {
        type: "object",
        properties: { summary: { type: "string" } },
        required: ["summary"],
        additionalProperties: false,
      };
      const schemaContract = await runtime.runPromise(makeSchemaContract(closedSchema));

      const r = await runtime.runPromise(
        Effect.gen(function* () {
          const admission = yield* Admission;
          return yield* admission.attemptStructured<{ summary: string }>({
            scope,
            route: { kind: "cf-ai-binding", modelId: "@cf/test/model" },
            schemaContract,
            strategy: "forced-tool-call",
            stimulus: {
              kind: "live",
              userInput: { userText: "hi" },
              deliver: (d) => ({ event: "structured.done", payload: d }),
            },
          });
        }),
      );

      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.outcome.class).toBe("BehaviorFailed");
        if (r.outcome.class === "BehaviorFailed") {
          expect(r.outcome.sampleDigest).toContain("unknown-property");
        }
      }

      // No deliver row should have been written.
      const events = await runtime.runPromise(
        Effect.gen(function* () {
          const l = yield* Ledger;
          return yield* l.events(scope);
        }),
      );
      const deliveries = events.filter((e) => e.kind === "structured.done");
      expect(deliveries).toHaveLength(0);

      await runtime.dispose();
    });
  });

  it("happy path: evidence + deliver committed atomically; lease-bearing first, reinforcement on second", async () => {
    const scope = "admission-happy";
    const id = testEnv.AGENT_DO.idFromName(scope);
    const stub = testEnv.AGENT_DO.get(id);

    await runInDurableObject(stub, async (_inst, state) => {
      const ai = stubAi([
        submitStructuredResp('{"summary":"first"}', "c1"),
        submitStructuredResp('{"summary":"second"}', "c2"),
      ]);
      const runtime = makeRuntime(state, ai);

      const schemaContract = await runtime.runPromise(makeSchemaContract(SCHEMA));

      // Two consecutive Supported attempts in same scope.
      const r1 = await runtime.runPromise(
        Effect.gen(function* () {
          const admission = yield* Admission;
          return yield* admission.attemptStructured<{ summary: string }>({
            scope,
            route: { kind: "cf-ai-binding", modelId: "@cf/test/model" },
            schemaContract,
            strategy: "forced-tool-call",
            stimulus: {
              kind: "live",
              userInput: { userText: "hello" },
              deliver: (decoded) => ({
                event: "structured.done",
                payload: decoded,
              }),
            },
          });
        }),
      );

      expect(r1.ok).toBe(true);
      expect(r1.admissionImpact).toBe("lease-bearing");
      if (r1.ok) {
        expect(r1.decoded).toEqual({ summary: "first" });
      }

      const r2 = await runtime.runPromise(
        Effect.gen(function* () {
          const admission = yield* Admission;
          return yield* admission.attemptStructured<{ summary: string }>({
            scope,
            route: { kind: "cf-ai-binding", modelId: "@cf/test/model" },
            schemaContract,
            strategy: "forced-tool-call",
            stimulus: {
              kind: "live",
              userInput: { userText: "hello again" },
              deliver: (decoded) => ({
                event: "structured.done",
                payload: decoded,
              }),
            },
          });
        }),
      );

      expect(r2.ok).toBe(true);
      expect(r2.admissionImpact).toBe("reinforcement");

      // Ledger contents: 2 evidence rows + 2 deliver rows (one for each).
      const events = await runtime.runPromise(
        Effect.gen(function* () {
          const l = yield* Ledger;
          return yield* l.events(scope);
        }),
      );
      const counts = events.reduce<Record<string, number>>((acc, e) => {
        acc[e.kind] = (acc[e.kind] ?? 0) + 1;
        return acc;
      }, {});
      expect(counts["llm.structured.evidence"]).toBe(2);
      expect(counts["structured.done"]).toBe(2);

      await runtime.dispose();
    });
  });

  it("short-circuit after BehaviorFailed: second call does NOT consume the AI queue", async () => {
    const scope = "admission-short-circuit";
    const id = testEnv.AGENT_DO.idFromName(scope);
    const stub = testEnv.AGENT_DO.get(id);

    await runInDurableObject(stub, async (_inst, state) => {
      // Only ONE stub response. If the second attemptStructured call
      // calls ai.run again, the queue throws → SqlError-equivalent test
      // failure. The lease short-circuit must prevent that call.
      const ai = stubAi([
        submitStructuredResp('{"summary":"first-and-only"}', "c1"),
      ]);
      const runtime = makeRuntime(state, ai);

      const schemaContract = await runtime.runPromise(makeSchemaContract(SCHEMA));

      const route = { kind: "cf-ai-binding" as const, modelId: "@cf/test/model" };

      // First call: adapterMode=test-decode-mismatch forces BehaviorFailed
      // despite the stub returning a valid response. (The AI is called
      // because the adapter's decode is what fails, not the provider.)
      const r1 = await runtime.runPromise(
        Effect.gen(function* () {
          const admission = yield* Admission;
          return yield* admission.attemptStructured<{ summary: string }>({
            scope,
            route,
            schemaContract,
            strategy: "forced-tool-call",
            stimulus: {
              kind: "live",
              userInput: { userText: "x" },
              deliver: (d) => ({ event: "structured.done", payload: d }),
            },
            adapterMode: "test-decode-mismatch",
          });
        }),
      );
      expect(r1.ok).toBe(false);
      if (!r1.ok) {
        expect(r1.outcome.class).toBe("BehaviorFailed");
        expect(r1.shortCircuited).toBe(false); // first call was the admission probe
      }

      // Second call: lease is unsupported; provider must NOT be called.
      const r2 = await runtime.runPromise(
        Effect.gen(function* () {
          const admission = yield* Admission;
          return yield* admission.attemptStructured<{ summary: string }>({
            scope,
            route,
            schemaContract,
            strategy: "forced-tool-call",
            stimulus: {
              kind: "live",
              userInput: { userText: "y" },
              deliver: (d) => ({ event: "structured.done", payload: d }),
            },
          });
        }),
      );
      expect(r2.ok).toBe(false);
      if (!r2.ok) {
        expect(r2.shortCircuited).toBe(true);
        expect(r2.outcome.class).toBe("BehaviorFailed");
      }

      await runtime.dispose();
    });
  });

  it("invalidate barrier resets the lease — next attempt re-probes provider", async () => {
    const scope = "admission-invalidate";
    const id = testEnv.AGENT_DO.idFromName(scope);
    const stub = testEnv.AGENT_DO.get(id);

    await runInDurableObject(stub, async (_inst, state) => {
      const ai = stubAi([
        // first call: forced to BehaviorFailed
        submitStructuredResp('{"summary":"ignored"}', "c1"),
        // post-barrier call: provider is invoked again
        submitStructuredResp('{"summary":"post-barrier"}', "c2"),
      ]);
      const runtime = makeRuntime(state, ai);
      const schemaContract = await runtime.runPromise(makeSchemaContract(SCHEMA));
      const route = { kind: "cf-ai-binding" as const, modelId: "@cf/test/model" };

      // 1) BehaviorFailed
      await runtime.runPromise(
        Effect.gen(function* () {
          const admission = yield* Admission;
          yield* admission.attemptStructured<{ summary: string }>({
            scope,
            route,
            schemaContract,
            strategy: "forced-tool-call",
            stimulus: {
              kind: "live",
              userInput: { userText: "x" },
              deliver: (d) => ({ event: "structured.done", payload: d }),
            },
            adapterMode: "test-decode-mismatch",
          });
        }),
      );

      // 2) Append barrier
      await runtime.runPromise(
        Effect.gen(function* () {
          const admission = yield* Admission;
          yield* admission.invalidate({
            scope,
            key: {
              routeFingerprint: routeFingerprint(route),
              schemaFingerprint: schemaContract.fingerprint,
              strategy: "forced-tool-call",
              adapterVersion: ADAPTER_VERSION,
            },
            reason: "test reset",
            by: "test",
          });
        }),
      );

      // 3) Next attempt — barrier wipes lease, provider IS called and
      // returns the second stub response (Supported this time).
      const r3 = await runtime.runPromise(
        Effect.gen(function* () {
          const admission = yield* Admission;
          return yield* admission.attemptStructured<{ summary: string }>({
            scope,
            route,
            schemaContract,
            strategy: "forced-tool-call",
            stimulus: {
              kind: "live",
              userInput: { userText: "y" },
              deliver: (d) => ({ event: "structured.done", payload: d }),
            },
          });
        }),
      );
      expect(r3.ok).toBe(true);
      if (r3.ok) {
        expect(r3.decoded).toEqual({ summary: "post-barrier" });
        expect(r3.admissionImpact).toBe("lease-bearing"); // post-barrier first Supported = admission-forming
      }

      await runtime.dispose();
    });
  });
});

// ============================================================
// Codex P2 regression guard: malformed admission payload → SqlError,
// NOT a raw `TypeError: undefined is not an object` defect leaking out
// of projectLease. Mirrors quota's malformed-payload defense.
// ============================================================

describe("admission — malformed payload → SqlError (Codex P2)", () => {
  it("evidence row missing `key` field → SqlError escapes Promise", async () => {
    const scope = "admission-malformed-evidence";
    const id = testEnv.AGENT_DO.idFromName(scope);
    const stub = testEnv.AGENT_DO.get(id);

    await runInDurableObject(stub, async (_inst, state) => {
      const ai = stubAi([]);
      const runtime = makeRuntime(state, ai);
      const schemaContract = await runtime.runPromise(makeSchemaContract(SCHEMA));

      state.storage.sql.exec(
        "INSERT INTO events (ts, kind, scope, payload) VALUES (?, ?, ?, ?)",
        Date.now(),
        "llm.structured.evidence",
        scope,
        JSON.stringify({
          stimulusKind: "live",
          outcome: { class: "Supported", tokensUsed: 10 },
          admissionImpact: "lease-bearing",
        }),
      );

      const exit = await runtime.runPromiseExit(
        Effect.gen(function* () {
          const admission = yield* Admission;
          return yield* admission.attemptStructured<{ summary: string }>({
            scope,
            route: { kind: "cf-ai-binding", modelId: "@cf/test/model" },
            schemaContract,
            strategy: "forced-tool-call",
            stimulus: {
              kind: "live",
              userInput: { userText: "x" },
              deliver: (d) => ({ event: "structured.done", payload: d }),
            },
          });
        }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(Option.isSome(failure)).toBe(true);
        if (Option.isSome(failure)) {
          expect((failure.value as { _tag: string })._tag).toBe(
            "agent_os.sql_error",
          );
        }
      }

      await runtime.dispose();
    });
  });

  it("invalidate row with non-object `key` → SqlError escapes Promise", async () => {
    const scope = "admission-malformed-invalidate";
    const id = testEnv.AGENT_DO.idFromName(scope);
    const stub = testEnv.AGENT_DO.get(id);

    await runInDurableObject(stub, async (_inst, state) => {
      const ai = stubAi([]);
      const runtime = makeRuntime(state, ai);
      const schemaContract = await runtime.runPromise(makeSchemaContract(SCHEMA));

      state.storage.sql.exec(
        "INSERT INTO events (ts, kind, scope, payload) VALUES (?, ?, ?, ?)",
        Date.now(),
        "llm.structured.invalidate",
        scope,
        JSON.stringify({
          key: "not-an-object",
          reason: "test",
          by: "test",
        }),
      );

      const exit = await runtime.runPromiseExit(
        Effect.gen(function* () {
          const admission = yield* Admission;
          return yield* admission.attemptStructured<{ summary: string }>({
            scope,
            route: { kind: "cf-ai-binding", modelId: "@cf/test/model" },
            schemaContract,
            strategy: "forced-tool-call",
            stimulus: {
              kind: "live",
              userInput: { userText: "x" },
              deliver: (d) => ({ event: "structured.done", payload: d }),
            },
          });
        }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(Option.isSome(failure)).toBe(true);
        if (Option.isSome(failure)) {
          expect((failure.value as { _tag: string })._tag).toBe(
            "agent_os.sql_error",
          );
        }
      }

      await runtime.dispose();
    });
  });
});

// ============================================================
// Cross-route structured-output dispatch (v0.2.13)
//
// Invariant: structured output must dispatch on `route.kind` exactly like
// free-text submit does (no parallel transport in admission). Without
// this, evidence rows would be tagged with one route while a different
// transport actually served the call — SSoT corruption.
// ============================================================

const SENTINEL_AI: Ai = {
  run: (() => {
    throw new Error(
      "SENTINEL_AI: admission should NOT touch AiBinding when route is openai-chat-compatible",
    );
  }) as Ai["run"],
} as Ai;

describe("admission — cross-route structured output (v0.2.13)", () => {
  it("openai-chat-compatible route MUST NOT touch AiBinding; evidence is tagged with the route's adapter", async () => {
    const scope = "cross-route-openai-compat";
    const id = testEnv.AGENT_DO.idFromName(scope);
    const stub = testEnv.AGENT_DO.get(id);

    // Capture the fetch call to assert URL, auth header, body shape.
    const fetchCalls: Array<{
      readonly url: string;
      readonly init: RequestInit;
    }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      fetchCalls.push({ url: String(input), init: init ?? {} });
      // Return a Chat Completions shaped response with the expected
      // _submit_structured tool call.
      const body = {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: "c1",
                  type: "function",
                  function: {
                    name: "_submit_structured",
                    arguments: JSON.stringify({ summary: "via-openrouter" }),
                  },
                },
              ],
            },
          },
        ],
        usage: { total_tokens: 42 },
      };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;

    try {
      await runInDurableObject(stub, async (_inst, state) => {
        // AiBinding is the SENTINEL that throws on any call. ProviderRegistry
        // resolves to a stub endpoint + credential.
        const runtime = makeRuntimeWithRegistry(
          state,
          SENTINEL_AI,
          { openrouter: "https://stub.openrouter.test/api/v1" },
          { OPENROUTER_KEY: "stub-key-not-real" },
        );

        const spec: InternalSubmitSpec = {
          intent: "summarize",
          context: {},
          route: {
            kind: "openai-chat-compatible",
            endpointRef: "openrouter",
            credentialRef: "OPENROUTER_KEY",
            modelId: "openai/gpt-4.1",
          },
          tools: {},
          outputSchema: SCHEMA,
          deliver: { scope, event: "structured.done" },
        };

        const r = await runtime.runPromise(submitAgentEffect(spec));

        // Success
        expect(r.ok).toBe(true);
        if (r.ok) {
          expect(JSON.parse(r.final)).toEqual({ summary: "via-openrouter" });
        }

        // Fetch was called exactly once, with the right URL + auth.
        expect(fetchCalls).toHaveLength(1);
        expect(fetchCalls[0]?.url).toBe(
          "https://stub.openrouter.test/api/v1/chat/completions",
        );
        const headers = fetchCalls[0]?.init.headers as
          | Record<string, string>
          | undefined;
        expect(headers?.Authorization).toBe("Bearer stub-key-not-real");

        // AiBinding sentinel was NEVER called (if it had been, SENTINEL_AI
        // would have thrown a string containing "SENTINEL_AI").

        // Evidence row tags the chosen adapter (openai-chat-compatible),
        // NOT cf-ai-binding. routeFingerprint reflects the variant fields.
        const events = await runtime.runPromise(
          Effect.gen(function* () {
            const l = yield* Ledger;
            return yield* l.events(scope);
          }),
        );
        const evidence = events.find(
          (e) => e.kind === "llm.structured.evidence",
        );
        expect(evidence).toBeDefined();
        const ep = evidence?.payload as {
          adapterId?: string;
          key?: { routeFingerprint?: string };
        };
        expect(ep.adapterId?.startsWith("openai-chat-compatible@")).toBe(true);
        expect(ep.key?.routeFingerprint).toContain('"openai-chat-compatible"');
        expect(ep.key?.routeFingerprint).toContain('"OPENROUTER_KEY"');
        expect(ep.key?.routeFingerprint).toContain('"openrouter"');

        // adapterVersion in the AttemptKey reflects the chosen adapter's version.
        const adapterKey = (
          ep as unknown as { key: { adapterVersion?: string } }
        ).key;
        expect(adapterKey.adapterVersion).toBe(ADAPTER_VERSION);

        await runtime.dispose();
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("cf-ai-binding route still goes through AiBinding (regression guard)", async () => {
    const scope = "cross-route-cf-ai-binding";
    const id = testEnv.AGENT_DO.idFromName(scope);
    const stub = testEnv.AGENT_DO.get(id);

    // Sentinel fetch: any HTTP call here is a bug.
    const originalFetch = globalThis.fetch;
    let fetchTouched = false;
    globalThis.fetch = (async () => {
      fetchTouched = true;
      throw new Error(
        "SENTINEL_FETCH: cf-ai-binding route should NOT hit fetch",
      );
    }) as typeof globalThis.fetch;

    try {
      await runInDurableObject(stub, async (_inst, state) => {
        const ai = stubAi([
          submitStructuredResp('{"summary":"via-cf-ai"}', "c1"),
        ]);
        const runtime = makeRuntimeWithRegistry(
          state,
          ai,
          { openrouter: "https://stub.test/v1" },
          { OPENROUTER_KEY: "stub" },
        );

        const spec: InternalSubmitSpec = {
          intent: "summarize",
          context: {},
          route: { kind: "cf-ai-binding", modelId: "@cf/test/model" } as const,
          tools: {},
          outputSchema: SCHEMA,
          deliver: { scope, event: "structured.done" },
        };

        const r = await runtime.runPromise(submitAgentEffect(spec));
        expect(r.ok).toBe(true);
        expect(fetchTouched).toBe(false);

        const events = await runtime.runPromise(
          Effect.gen(function* () {
            const l = yield* Ledger;
            return yield* l.events(scope);
          }),
        );
        const evidence = events.find(
          (e) => e.kind === "llm.structured.evidence",
        );
        const ep = evidence?.payload as { adapterId?: string };
        expect(ep.adapterId?.startsWith("cf-ai-binding@")).toBe(true);

        await runtime.dispose();
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
