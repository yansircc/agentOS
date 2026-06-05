import { Effect, Schema } from "effect";
import { describe, expect, it } from "@effect/vitest";
import type { LlmRequest, LlmResponse } from "@agent-os/kernel/llm";
import type { LedgerEvent } from "@agent-os/kernel/types";
import { defineTool, pureToolExecution } from "@agent-os/kernel/tools";
import { Admission } from "../src/admission";
import { Ledger } from "../src/ledger";
import { LlmTransport } from "../src/llm-transport";
import { Quota } from "../src/quota-service";
import { submitAgentEffect } from "../src/submit-agent";
import type { InternalSubmitSpec } from "../src/submit";
import { decodeRuntimeLedgerEvent } from "../src/runtime-events";

const scope = "submit-runtime-events";
const eventIdentity = (scopeId: string) => ({
  scopeRef: { kind: "conversation" as const, scopeId },
  factOwnerRef: "@agent-os/test",
  effectAuthorityRef: { authorityClass: "test", authorityId: scopeId },
});
const traceContext = {
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  tracestate: "vendor=value",
};

const baseSpec = (overrides: Partial<InternalSubmitSpec> = {}): InternalSubmitSpec => ({
  intent: "answer",
  context: { topic: "runtime events" },
  route: {
    kind: "openai-chat-compatible",
    endpointRef: "test-endpoint",
    credentialRef: "test-credential",
    modelId: "test-model",
  },
  tools: {},
  scope,
  scopeRef: { kind: "conversation", scopeId: scope },
  effectAuthorityRef: { authorityClass: "llm_route", authorityId: "test-route" },
  ...overrides,
});

const response = (override: Partial<LlmResponse> = {}): LlmResponse => ({
  items: [{ type: "message", text: "done" }],
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  ...override,
});

const makeServices = (responses: ReadonlyArray<LlmResponse> = [response()]) => {
  const events: LedgerEvent[] = [];
  const llmRequests: LlmRequest[] = [];
  let nextId = 1;
  let callIndex = 0;
  const ledger = {
    commit: (
      specs: ReadonlyArray<{
        readonly kind: string;
        readonly payload: unknown;
        readonly scope: string;
        readonly ts?: number;
      }>,
    ) =>
      Effect.sync(() => {
        const committed = specs.map((spec) => {
          const id = nextId++;
          return {
            id,
            ts: spec.ts ?? id * 10,
            kind: spec.kind,
            ...eventIdentity(spec.scope),
            payload: spec.payload,
          };
        });
        events.push(...committed);
        return committed;
      }),
    events: () => Effect.succeed(events),
    streamSnapshot: () => Effect.succeed(events),
  };
  const llm = {
    describeRoute: () => ({
      providerOutputAdapterId: "test-provider-output@1.0.0",
      providerOutputAdapterVersion: "1.0.0",
      transportAdapterId: "test-runtime@1.0.0",
      transportAdapterVersion: "1.0.0",
    }),
    call: (request: LlmRequest) =>
      Effect.sync(() => {
        llmRequests.push(request);
        const next = responses[callIndex] ?? response();
        callIndex += 1;
        return next;
      }),
  };
  const quota = {
    tryGrant: () => Effect.succeed({ granted: true, consumed: 0, limit: 1 }),
  };
  const admission = {
    attemptStructured: <O>() =>
      Effect.succeed({
        ok: true as const,
        decoded: { summary: "structured" } as O,
        outcome: { class: "Supported" as const, tokensUsed: 2 },
        lease: {
          status: "supported" as const,
          pinnedStrategy: "forced-tool-call" as const,
          validUntilSoft: 1,
          validUntilHard: 2,
          lastEvidenceTs: 1,
        },
        admissionImpact: "lease-bearing" as const,
        shortCircuited: false as const,
      }),
    invalidate: () => Effect.succeed({ barrierId: 1 }),
  };
  return { events, llmRequests, ledger, llm, quota, admission };
};

const runSubmit = (spec: InternalSubmitSpec, responses?: ReadonlyArray<LlmResponse>) => {
  const services = makeServices(responses);
  const effect = submitAgentEffect(spec).pipe(
    Effect.provideService(Ledger, services.ledger),
    Effect.provideService(LlmTransport, services.llm),
    Effect.provideService(Quota, services.quota),
    Effect.provideService(Admission, services.admission),
  );
  return Effect.map(effect, (result) => ({
    result,
    events: services.events,
    llmRequests: services.llmRequests,
  }));
};

const decodedRuntimeKinds = (events: ReadonlyArray<LedgerEvent>): ReadonlyArray<string> =>
  events.flatMap((event) => {
    const decoded = decodeRuntimeLedgerEvent(event);
    return decoded._tag === "runtime" ? [decoded.event.kind] : [];
  });

const expectRuntimePayloadsDecode = (events: ReadonlyArray<LedgerEvent>) => {
  for (const event of events) {
    decodeRuntimeLedgerEvent(event);
  }
};

describe("submit-agent runtime event writes", () => {
  it.effect("standard submit emits constructor-backed runtime facts", () =>
    Effect.gen(function* () {
      const { result, events } = yield* runSubmit(baseSpec());

      expect(result).toMatchObject({ ok: true, final: "done" });
      expectRuntimePayloadsDecode(events);
      expect(decodedRuntimeKinds(events)).toEqual([
        "agent.run.started",
        "chat.ingested",
        "llm.response",
        "agent.run.completed",
      ]);
      expect(decodeRuntimeLedgerEvent(events[3]!)).toMatchObject({
        _tag: "runtime",
        event: {
          kind: "agent.run.completed",
          payload: {
            runId: 1,
            final: "done",
            output: "done",
            outputKind: "text",
            tokensUsed: 2,
          },
        },
      });
    }),
  );

  it.effect("structured submit emits constructor-backed terminal facts", () =>
    Effect.gen(function* () {
      const { result, events } = yield* runSubmit(
        baseSpec({
          outputSchema: Schema.Struct({ summary: Schema.String }),
        }),
      );

      expect(result).toMatchObject({ ok: true });
      expectRuntimePayloadsDecode(events);
      expect(decodedRuntimeKinds(events)).toEqual([
        "agent.run.started",
        "chat.ingested",
        "agent.run.completed",
      ]);
    }),
  );

  it.effect("token budget abort emits a decodable abort fact", () =>
    Effect.gen(function* () {
      const { result, events } = yield* runSubmit(baseSpec({ budget: { tokens: 1 } }));

      expect(result).toMatchObject({ ok: false, reason: "budget_tokens" });
      expectRuntimePayloadsDecode(events);
      expect(decodedRuntimeKinds(events)).toEqual([
        "agent.run.started",
        "chat.ingested",
        "llm.response",
        "agent.aborted.budget_tokens",
      ]);
    }),
  );

  it.effect("tool admission failure emits decodable tool rejection and abort facts", () =>
    Effect.gen(function* () {
      const tool = defineTool({
        name: "lookup",
        description: "lookup",
        args: Schema.Struct({ q: Schema.String }),
        execute: () => ({ ok: true }),
        authority: "read",
        admit: () => ({
          ok: false,
          rejectionRef: {
            rejectionId: "lookup-denied",
            rejectionKind: "policy_denied",
            reason: "denied",
          },
        }),
        execution: pureToolExecution(),
      });
      const { result, events } = yield* runSubmit(baseSpec({ tools: { lookup: tool } }), [
        response({
          items: [
            { type: "message", text: "use lookup" },
            {
              type: "tool_call",
              call: {
                id: "call-1",
                type: "function",
                function: { name: "lookup", arguments: '{"q":"x"}' },
              },
            },
          ],
        }),
      ]);

      expect(result).toMatchObject({ ok: false, reason: "tool_error" });
      expectRuntimePayloadsDecode(events);
      expect(decodedRuntimeKinds(events)).toEqual([
        "agent.run.started",
        "chat.ingested",
        "llm.response",
        "tool.rejected",
        "agent.aborted.tool_error",
      ]);
    }),
  );

  it.effect("propagates trace context through LLM request, tool context, and runtime facts", () =>
    Effect.gen(function* () {
      let toolTraceContext: unknown;
      const tool = defineTool({
        name: "lookup",
        description: "lookup",
        args: Schema.Struct({ q: Schema.String }),
        execute: (_args, ctx) => {
          toolTraceContext = ctx.traceContext;
          return { ok: true };
        },
        authority: "read",
        admit: () => ({ ok: true }),
        execution: pureToolExecution(),
      });

      const { result, events, llmRequests } = yield* runSubmit(
        baseSpec({ tools: { lookup: tool }, traceContext }),
        [
          response({
            items: [
              { type: "message", text: "use lookup" },
              {
                type: "tool_call",
                call: {
                  id: "call-1",
                  type: "function",
                  function: { name: "lookup", arguments: '{"q":"x"}' },
                },
              },
            ],
          }),
          response({ items: [{ type: "message", text: "done with tool" }] }),
        ],
      );

      expect(result).toMatchObject({ ok: true });
      expect(llmRequests[0]?.traceContext).toEqual(traceContext);
      expect(llmRequests[1]?.traceContext).toEqual(traceContext);
      expect(toolTraceContext).toEqual(traceContext);
      const runtimePayloads = events.flatMap((event) => {
        const decoded = decodeRuntimeLedgerEvent(event);
        return decoded._tag === "runtime" ? [decoded.event.payload] : [];
      });
      for (const payload of runtimePayloads) {
        expect(payload.traceContext).toEqual(traceContext);
      }
    }),
  );
});
