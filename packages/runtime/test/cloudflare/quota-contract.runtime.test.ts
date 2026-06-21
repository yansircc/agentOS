/**
 * Quota state machine — deterministic contract test.
 *
 * Bypasses the DO facade to compose production Layers directly (LedgerLive +
 * EventBusLive + QuotaLive over real DO SQLite from runInDurableObject's
 * state, plus a Layer.succeed(LlmTransport, stubLlmTransport(...))). This isolates the
 * substrate algorithm from any LLM behavior — every test result is
 * structurally determined by the canned response queue.
 *
 * Replaces the retired LLM-dependent spike quota assertions (reviewer's
 * 2026-05-25 P1 finding).
 */

import { Cause, Context, Effect, Exit, Layer, ManagedRuntime, Option, Schema } from "effect";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type {} from "@effect/vitest";

import { AdmissionLive } from "../../src/cloudflare/admission";
import { BoundaryEventsLive } from "../../src/cloudflare/boundary-events";
import { EventBusLive } from "../../src/cloudflare/ledger";
import { Ledger, LedgerLive } from "../../src/cloudflare/ledger";
import { RefResolverLive } from "@agent-os/core/ref-resolver";
import { QuotaLive } from "../../src/cloudflare/quota";
import { withQuota } from "../../src/cloudflare/quota";
import { ToolError } from "@agent-os/core/errors";
import { LlmTransport } from "@agent-os/core/llm-protocol";
import {
  MaterializedProjectionRegistry,
  internalSubmitSpec,
  submitAgentEffect,
  type InternalSubmitSpec,
} from "@agent-os/runtime";
import type { SubmitSpec } from "@agent-os/core/runtime-protocol";
import { defineTool, deterministicToolExecution, type Tool } from "@agent-os/core/tools";
import type { EventHandler } from "@agent-os/core/types";
import { finalTextResp, stubLlmTransport, toolCallResp } from "./_stub-ai";
import { testEventIdentity } from "./_identity";
import type { BackendProtocolEventIdentity } from "@agent-os/core/backend-protocol";
import { CloudflareMaterializedProjectionsLive } from "../../src/cloudflare/materialized-projections";

interface TestEnv {
  readonly AGENT_DO: DurableObjectNamespace;
}

const allowToolAdmitter = () => Effect.succeed({ ok: true as const });

const testEnv = env as unknown as TestEnv;

const makeQuotaTool = (limit: number): Tool =>
  withQuota(
    defineTool({
      name: "get_current_time",
      description: "Returns the current time as ISO string",
      args: Schema.Struct({}),
      execute: () => Effect.succeed("2026-05-25T00:00:00Z"),
      admit: allowToolAdmitter,
      authority: "read",
      execution: deterministicToolExecution(),
    }),
    { windowMs: 60_000, limit, amount: 1 },
  );

const quotaAuthorityRef = {
  authorityClass: "llm_route" as const,
  authorityId: "quota-contract",
};

const makePublicSpec = (limit: number): SubmitSpec => ({
  intent: "what time is it",
  context: {},
  route: {
    kind: "openai-chat-compatible",
    endpointRef: "test-endpoint",
    credentialRef: "test-credential",
    modelId: "test-model",
  } as const,
  tools: { get_current_time: makeQuotaTool(limit) },
  budget: { maxTurns: 3 },
  effectAuthorityRef: quotaAuthorityRef,
});

const makeSpec = (
  scope: string,
  limit: number,
  overrides: Partial<SubmitSpec> = {},
): InternalSubmitSpec =>
  internalSubmitSpec(
    {
      ...makePublicSpec(limit),
      ...overrides,
    },
    { scope, scopeRef: { kind: "conversation", scopeId: scope } },
  );

const buildRuntime = (
  state: DurableObjectState,
  llm: Context.Service.Shape<typeof LlmTransport>,
  identity: BackendProtocolEventIdentity,
) => {
  const handlers = new Map<string, Set<EventHandler>>();
  const eventBus = EventBusLive(handlers);
  const ledger = LedgerLive(state).pipe(Layer.provide(eventBus));
  const boundaryEvents = BoundaryEventsLive(state, identity).pipe(Layer.provide(eventBus));
  const projectionRegistry = Layer.succeed(MaterializedProjectionRegistry, new Map());
  const projections = CloudflareMaterializedProjectionsLive(state).pipe(
    Layer.provide(projectionRegistry),
  );
  const quota = QuotaLive(state, identity).pipe(Layer.provide(eventBus));
  const llmTransport = Layer.succeed(LlmTransport, llm);
  const refs = RefResolverLive({
    material: () => null,
  });
  const admission = AdmissionLive(state, identity).pipe(
    Layer.provide(Layer.mergeAll(eventBus, llmTransport)),
  );
  return ManagedRuntime.make(
    Layer.mergeAll(ledger, boundaryEvents, projections, quota, llmTransport, admission, refs),
  );
};

describe("quota state machine — deterministic", () => {
  it("tool retry reuses the same quota grant for the same operationRef", async () => {
    const scope = "quota-retry-idempotent";
    const id = testEnv.AGENT_DO.idFromName(scope);
    const stub = testEnv.AGENT_DO.get(id);

    await runInDurableObject(stub, async (_inst, state) => {
      let calls = 0;
      const retryingTool = withQuota(
        defineTool({
          name: "get_current_time",
          description: "Returns the current time as ISO string",
          args: Schema.Struct({}),
          execute: () =>
            Effect.sync(() => {
              calls += 1;
              return calls;
            }).pipe(
              Effect.flatMap((attempt) =>
                attempt === 1
                  ? Effect.fail(
                      new ToolError({
                        toolName: "get_current_time",
                        cause: { reason: "transient" },
                      }),
                    )
                  : Effect.succeed("2026-05-25T00:00:00Z"),
              ),
            ),
          admit: allowToolAdmitter,
          authority: "read",
          execution: deterministicToolExecution(),
        }),
        { windowMs: 60_000, limit: 1, amount: 1 },
      );
      const llm = stubLlmTransport([
        toolCallResp("get_current_time", "{}", "c1"),
        finalTextResp("ok"),
      ]);
      const routeIdentity = testEventIdentity(scope, quotaAuthorityRef);
      const quotaIdentity = testEventIdentity(scope, retryingTool.contract.effectAuthorityRef);
      const runtime = buildRuntime(state, llm, routeIdentity);
      const spec = makeSpec(scope, 1, {
        tools: { get_current_time: retryingTool },
        budget: {
          maxTurns: 3,
          toolRetryPolicy: { execution: { maxRetries: 1, delay: { kind: "none" } } },
        },
      });

      const result = await runtime.runPromise(submitAgentEffect(spec));

      expect(result.ok).toBe(true);
      expect(calls).toBe(2);
      const events = await runtime.runPromise(
        Effect.gen(function* () {
          const l = yield* Ledger;
          return yield* l.events(quotaIdentity);
        }),
      );
      expect(events.filter((event) => event.kind === "quota.consumed")).toHaveLength(1);
      expect(events.some((event) => event.kind === "quota.rate_limited")).toBe(false);

      await runtime.dispose();
    });
  });

  it("3 submits with limit=2 → 2 consumed, 1 rate_limited, 1 tool_error abort", async () => {
    const scope = "quota-rate-limit-3rd";
    const id = testEnv.AGENT_DO.idFromName(scope);
    const stub = testEnv.AGENT_DO.get(id);

    await runInDurableObject(stub, async (_inst, state) => {
      // Each successful submit: one tool_call turn, one final text turn.
      // Submit 3 hits rate_limit on the tool_call turn → aborts (no second
      // LLM call). 2*2 + 1 = 5 stub responses pre-loaded.
      const llm = stubLlmTransport([
        toolCallResp("get_current_time", "{}", "c1"),
        finalTextResp("ok 1"),
        toolCallResp("get_current_time", "{}", "c2"),
        finalTextResp("ok 2"),
        toolCallResp("get_current_time", "{}", "c3"),
      ]);

      const routeIdentity = testEventIdentity(scope, quotaAuthorityRef);
      const quotaIdentity = testEventIdentity(scope, makeQuotaTool(2).contract.effectAuthorityRef);
      const runtime = buildRuntime(state, llm, routeIdentity);

      const r1 = await runtime.runPromise(submitAgentEffect(makeSpec(scope, 2)));
      const r2 = await runtime.runPromise(submitAgentEffect(makeSpec(scope, 2)));
      const r3 = await runtime.runPromise(submitAgentEffect(makeSpec(scope, 2)));

      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      expect(r3.ok).toBe(false);
      if (!r3.ok) {
        expect(r3.reason).toBe("tool_error");
      }

      const quotaEvents = await runtime.runPromise(
        Effect.gen(function* () {
          const l = yield* Ledger;
          return yield* l.events(quotaIdentity);
        }),
      );
      const routeEvents = await runtime.runPromise(
        Effect.gen(function* () {
          const l = yield* Ledger;
          return yield* l.events(routeIdentity);
        }),
      );

      const quotaCounts = quotaEvents.reduce<Record<string, number>>((acc, e) => {
        acc[e.kind] = (acc[e.kind] ?? 0) + 1;
        return acc;
      }, {});
      const routeCounts = routeEvents.reduce<Record<string, number>>((acc, e) => {
        acc[e.kind] = (acc[e.kind] ?? 0) + 1;
        return acc;
      }, {});

      expect(quotaCounts["quota.consumed"]).toBe(2);
      expect(quotaCounts["quota.rate_limited"]).toBe(1);
      expect(routeCounts["agent.aborted.tool_error"]).toBe(1);

      await runtime.dispose();
    });
  });

  it("malformed quota.consumed payload -> RuntimeStorageError escapes Promise", async () => {
    const scope = "quota-malformed-payload";
    const id = testEnv.AGENT_DO.idFromName(scope);
    const stub = testEnv.AGENT_DO.get(id);

    await runInDurableObject(stub, async (_inst, state) => {
      // One stub response is enough — the submit aborts during the first
      // tryGrant call when it reads the corrupted row.
      const llm = stubLlmTransport([toolCallResp("get_current_time", "{}", "c1")]);

      const routeIdentity = testEventIdentity(scope, quotaAuthorityRef);
      const quotaIdentity = testEventIdentity(scope, makeQuotaTool(2).contract.effectAuthorityRef);
      const runtime = buildRuntime(state, llm, routeIdentity);

      // Commit a malformed quota.consumed row through the ledger primitive.
      // Payload is valid JSON but fails ConsumedPayloadSchema:
      //   - amount is "x" (not a finite number)
      //   - matches the key the tool will look up
      // Without the v0.2.9 P2 fix, this row would silently be parsed as
      // `consumed += NaN`, polluting the running total. With the fix,
      // Schema.decodeUnknownSync throws, the transaction rolls back, and the
      // runtime ledger port maps storage internals to RuntimeStorageError.
      await runtime.runPromise(
        Effect.gen(function* () {
          const ledger = yield* Ledger;
          yield* ledger.commit([
            {
              kind: "quota.consumed",
              scopeRef: quotaIdentity.scopeRef,
              effectAuthorityRef: quotaIdentity.effectAuthorityRef,
              payload: {
                key: "get_current_time",
                amount: "x",
                toolName: "get_current_time",
                operationRef: "bad-op",
              },
            },
          ]);
        }),
      );

      // Now run a submit that consumes quota. The Quota.tryGrant
      // transactionSync will SELECT the malformed row, decode fails,
      // transactionSync rolls back. RuntimeStorageError is not caught by
      // submitAgentEffect.catchTags, so it surfaces as a Cause.Fail.
      const exit = await runtime.runPromiseExit(submitAgentEffect(makeSpec(scope, 2)));

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure)).toBe(true);
        if (Option.isSome(failure)) {
          expect(failure.value._tag).toBe("agent_os.runtime_storage_error");
        }
      }

      await runtime.dispose();
    });
  });
});
