import { Effect, Schema } from "effect";
import { describe, expect, it } from "@effect/vitest";
import type { LlmRequest, LlmResponse, LlmRoute, LlmWireDescriptor } from "@agent-os/llm-protocol";
import type { LedgerEvent } from "@agent-os/kernel/types";
import type { BoundaryContract } from "@agent-os/kernel/boundary-contract";
import { defineTool, pureToolExecution } from "@agent-os/kernel/tools";
import { Admission } from "../src/admission";
import { BoundaryEvents } from "../src/boundary-events";
import { commitBoundaryEvent } from "../src/boundary-commit";
import { Ledger } from "../src/ledger";
import { LlmTransport } from "../src/llm-transport";
import { Quota } from "../src/quota-service";
import { submitAgentEffect } from "../src/submit-agent";
import {
  RUNTIME_FACT_OWNER,
  decodeRuntimeLedgerEvent,
  type InternalSubmitSpec,
} from "@agent-os/runtime-protocol";
import { RefResolutionFailed, RefResolverService } from "@agent-os/kernel/ref-resolver";
import type { ResolvedMaterial } from "@agent-os/kernel/ref-resolver";
import {
  credentialMaterialRef,
  materialRefKey,
  materialRequirement,
  type MaterialRef,
} from "@agent-os/kernel/material-ref";
import {
  DECISION_GATE_KIND,
  decisionGateBoundaryContract,
  projectDecisionGate,
} from "@agent-os/decision-gate";

const scope = "submit-runtime-events";
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

const routeKind = (route: LlmRoute): string =>
  typeof route.kind === "string" ? route.kind : "unknown";

const testWireDescriptor = (route: LlmRoute): LlmWireDescriptor => ({
  method: "POST",
  url: `test-llm://${routeKind(route)}`,
  headers: [
    ["x-agentos-endpoint-ref", String(route.endpointRef ?? "")],
    ["x-agentos-credential-ref", String(route.credentialRef ?? "")],
  ],
  bodySchema: {
    type: "object",
    properties: {
      messages: {
        type: "array",
        items: { type: "object", properties: {}, additionalProperties: true },
      },
    },
    additionalProperties: true,
  },
});

const makeServices = (
  responses: ReadonlyArray<LlmResponse> = [response()],
  materials: Readonly<Record<string, ResolvedMaterial>> = {},
) => {
  const events: LedgerEvent[] = [];
  const llmRequests: LlmRequest[] = [];
  let nextId = 1;
  let callIndex = 0;
  const ledger = {
    commit: (
      specs: ReadonlyArray<{
        readonly kind: string;
        readonly payload: unknown;
        readonly scopeRef: LedgerEvent["scopeRef"];
        readonly effectAuthorityRef: LedgerEvent["effectAuthorityRef"];
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
            scopeRef: spec.scopeRef,
            effectAuthorityRef: spec.effectAuthorityRef,
            factOwnerRef: RUNTIME_FACT_OWNER,
            payload: spec.payload,
          };
        });
        events.push(...committed);
        return committed;
      }),
    events: () => Effect.succeed(events),
    streamSnapshot: () => Effect.succeed(events),
  };
  const boundaryEvents = {
    commit: (contract: BoundaryContract, event: string, payload: unknown) =>
      commitBoundaryEvent(contract, event, payload, (identity) =>
        Effect.sync(() => {
          const id = nextId++;
          const committed = {
            id,
            ts: id * 10,
            kind: event,
            scopeRef: identity.scopeRef ?? { kind: "conversation", scopeId: scope },
            effectAuthorityRef: identity.effectAuthorityRef ?? {
              authorityClass: "llm_route",
              authorityId: "test-route",
            },
            factOwnerRef: identity.factOwnerRef,
            payload,
          } satisfies LedgerEvent;
          events.push(committed);
          return committed;
        }),
      ),
  };
  const llm = {
    resolveRoute: (route: LlmRoute) =>
      Effect.succeed({
        wireDescriptor: testWireDescriptor(route),
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
  const refs = {
    material: (ref: MaterialRef) => {
      const value = materials[materialRefKey(ref)];
      return value === undefined
        ? Effect.fail(new RefResolutionFailed({ kind: ref.kind, ref: materialRefKey(ref) }))
        : Effect.succeed(value);
    },
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
  return { events, llmRequests, ledger, boundaryEvents, llm, quota, refs, admission };
};

const runSubmit = (spec: InternalSubmitSpec, responses?: ReadonlyArray<LlmResponse>) => {
  const services = makeServices(responses);
  return runSubmitWithServices(spec, services);
};

const runSubmitWithServices = (
  spec: InternalSubmitSpec,
  services: ReturnType<typeof makeServices>,
) => {
  const effect = submitAgentEffect(spec).pipe(
    Effect.provideService(Ledger, services.ledger),
    Effect.provideService(BoundaryEvents, services.boundaryEvents),
    Effect.provideService(LlmTransport, services.llm),
    Effect.provideService(Quota, services.quota),
    Effect.provideService(RefResolverService, services.refs),
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

  it.effect("passes resolved declared material to tool context without writing it to ledger", () =>
    Effect.gen(function* () {
      const tokenRef = credentialMaterialRef("WP_TOKEN", {
        provider: "wordpress",
        purpose: "apply",
      });
      let observedToken: unknown;
      const tool = defineTool({
        name: "apply",
        description: "apply",
        args: Schema.Struct({ title: Schema.String }),
        execute: (_args, ctx) => {
          observedToken = ctx.materials.wp_token;
          return { applied: true };
        },
        authority: "write",
        requiredMaterials: [
          materialRequirement({
            slot: "wp_token",
            kind: "credential",
            provider: "wordpress",
            purpose: "apply",
          }),
        ],
        admit: () => ({ ok: true }),
        execution: pureToolExecution(),
      });

      const services = makeServices(
        [
          response({
            items: [
              { type: "message", text: "use apply" },
              {
                type: "tool_call",
                call: {
                  id: "call-1",
                  type: "function",
                  function: { name: "apply", arguments: '{"title":"Hello"}' },
                },
              },
            ],
          }),
          response({ items: [{ type: "message", text: "done" }] }),
        ],
        { [materialRefKey(tokenRef)]: "secret-token-value" },
      );

      const { result, events } = yield* runSubmitWithServices(
        baseSpec({
          tools: { apply: tool },
          materials: { wp_token: tokenRef },
        }),
        services,
      );

      expect(result).toMatchObject({ ok: true, final: "done" });
      expect(observedToken).toBe("secret-token-value");
      expect(JSON.stringify(events)).not.toContain("secret-token-value");
      expect(decodedRuntimeKinds(events)).toEqual([
        "agent.run.started",
        "chat.ingested",
        "llm.response",
        "tool.executed",
        "llm.response",
        "agent.run.completed",
      ]);
    }),
  );

  it.effect("rejects a missing required material before tool execution", () =>
    Effect.gen(function* () {
      let executed = false;
      const tool = defineTool({
        name: "apply",
        description: "apply",
        args: Schema.Struct({ title: Schema.String }),
        execute: () => {
          executed = true;
          return { applied: true };
        },
        authority: "write",
        requiredMaterials: [
          materialRequirement({
            slot: "wp_token",
            kind: "credential",
            provider: "wordpress",
            purpose: "apply",
          }),
        ],
        admit: () => ({ ok: true }),
        execution: pureToolExecution(),
      });

      const { result, events } = yield* runSubmit(
        baseSpec({
          tools: { apply: tool },
        }),
        [
          response({
            items: [
              { type: "message", text: "use apply" },
              {
                type: "tool_call",
                call: {
                  id: "call-1",
                  type: "function",
                  function: { name: "apply", arguments: '{"title":"Hello"}' },
                },
              },
            ],
          }),
        ],
      );

      expect(result).toMatchObject({ ok: false, reason: "tool_error" });
      expect(executed).toBe(false);
      const rejected = events.find((event) => event.kind === "tool.rejected");
      expect(JSON.stringify(rejected?.payload)).toContain("material_missing:wp_token");
      expect(JSON.stringify(events)).not.toContain("secret-token-value");
    }),
  );

  it.effect("interrupts an externally gated tool before execution", () =>
    Effect.gen(function* () {
      let executed = 0;
      const tool = defineTool({
        name: "publish",
        description: "publish",
        args: Schema.Struct({ title: Schema.String }),
        execute: () => {
          executed += 1;
          return { ok: true };
        },
        authority: "write",
        admit: () => ({ ok: true }),
        execution: pureToolExecution(),
      });

      const { result, events } = yield* runSubmit(
        baseSpec({
          tools: { publish: tool },
          decisionInterrupts: [
            {
              toolName: "publish",
              reason: "approval_required",
              policyRef: "policy/editor-approval",
              resumeSchema: { type: "object", required: ["approved"] },
            },
          ],
        }),
        [
          response({
            items: [
              { type: "message", text: "use publish" },
              {
                type: "tool_call",
                call: {
                  id: "call-1",
                  type: "function",
                  function: { name: "publish", arguments: '{"title":"Hello"}' },
                },
              },
            ],
          }),
        ],
      );

      expect(result).toMatchObject({
        ok: false,
        reason: "interrupted",
        runId: 1,
        interruptId: "decision:tool%3Asubmit-runtime-events%3A1%3A0%3Acall-1",
      });
      expect(executed).toBe(0);
      if (result.status !== "interrupted") {
        throw new Error("expected interrupted result");
      }
      expect(decodedRuntimeKinds(events)).toEqual([
        "agent.run.started",
        "chat.ingested",
        "llm.response",
        "agent.run.interrupted",
      ]);
      expect(projectDecisionGate(events, result.gateRef)).toMatchObject({
        status: "requested",
      });
    }),
  );

  it.effect("consumes an approved decision exactly once before resuming tool execution", () =>
    Effect.gen(function* () {
      let executed = 0;
      const tool = defineTool({
        name: "publish",
        description: "publish",
        args: Schema.Struct({ title: Schema.String }),
        execute: () => {
          executed += 1;
          return { applied: true };
        },
        authority: "write",
        admit: () => ({ ok: true }),
        execution: pureToolExecution(),
      });
      const services = makeServices([
        response({
          items: [
            { type: "message", text: "use publish" },
            {
              type: "tool_call",
              call: {
                id: "call-1",
                type: "function",
                function: { name: "publish", arguments: '{"title":"Hello"}' },
              },
            },
          ],
        }),
        response({ items: [{ type: "message", text: "published" }] }),
      ]);

      const first = yield* runSubmitWithServices(
        baseSpec({
          tools: { publish: tool },
          decisionInterrupts: [{ toolName: "publish", reason: "approval_required" }],
        }),
        services,
      );
      expect(first.result).toMatchObject({ ok: false, reason: "interrupted" });
      if (first.result.status !== "interrupted") {
        throw new Error("expected interrupted result");
      }

      yield* services.boundaryEvents.commit(
        decisionGateBoundaryContract,
        DECISION_GATE_KIND.DECIDED,
        {
          gateRef: first.result.gateRef,
          decisionRef: "decision/1",
          decision: "approved",
          decidedBy: "operator/alice",
        },
      );

      const resumed = yield* runSubmitWithServices(
        baseSpec({
          tools: { publish: tool },
          resume: {
            runId: first.result.runId,
            turn: first.result.turn,
            interruptId: first.result.interruptId,
            gateRef: first.result.gateRef,
            decisionRef: "decision/1",
            resume: { approved: true },
          },
        }),
        services,
      );

      expect(resumed.result).toMatchObject({ ok: true, final: "published" });
      expect(executed).toBe(1);
      expect(projectDecisionGate(services.events, first.result.gateRef)).toMatchObject({
        status: "consumed",
      });
      expect(decodedRuntimeKinds(services.events)).toEqual([
        "agent.run.started",
        "chat.ingested",
        "llm.response",
        "agent.run.interrupted",
        "agent.run.resumed",
        "tool.executed",
        "llm.response",
        "agent.run.completed",
      ]);

      const duplicate = yield* runSubmitWithServices(
        baseSpec({
          tools: { publish: tool },
          resume: {
            runId: first.result.runId,
            turn: first.result.turn,
            interruptId: first.result.interruptId,
            gateRef: first.result.gateRef,
            decisionRef: "decision/1",
            resume: { approved: true },
          },
        }),
        services,
      );
      expect(duplicate.result).toMatchObject({ ok: true, final: "published" });
      expect(executed).toBe(1);
      expect(
        services.events.filter((event) => event.kind === DECISION_GATE_KIND.CONSUMED),
      ).toHaveLength(1);
    }),
  );

  it.effect("does not execute a tool when the matching decision is rejected", () =>
    Effect.gen(function* () {
      let executed = 0;
      const tool = defineTool({
        name: "publish",
        description: "publish",
        args: Schema.Struct({ title: Schema.String }),
        execute: () => {
          executed += 1;
          return { applied: true };
        },
        authority: "write",
        admit: () => ({ ok: true }),
        execution: pureToolExecution(),
      });
      const services = makeServices([
        response({
          items: [
            { type: "message", text: "use publish" },
            {
              type: "tool_call",
              call: {
                id: "call-1",
                type: "function",
                function: { name: "publish", arguments: '{"title":"Hello"}' },
              },
            },
          ],
        }),
      ]);

      const first = yield* runSubmitWithServices(
        baseSpec({
          tools: { publish: tool },
          decisionInterrupts: [{ toolName: "publish", reason: "approval_required" }],
        }),
        services,
      );
      if (first.result.status !== "interrupted") {
        throw new Error("expected interrupted result");
      }

      yield* services.boundaryEvents.commit(
        decisionGateBoundaryContract,
        DECISION_GATE_KIND.DECIDED,
        {
          gateRef: first.result.gateRef,
          decisionRef: "decision/2",
          decision: "rejected",
          decidedBy: "operator/bob",
          rejectionRef: {
            rejectionId: "decision/2",
            rejectionKind: "policy_denied",
            reason: "not allowed",
          },
        },
      );

      const resumed = yield* runSubmitWithServices(
        baseSpec({
          tools: { publish: tool },
          resume: {
            runId: first.result.runId,
            turn: first.result.turn,
            interruptId: first.result.interruptId,
            gateRef: first.result.gateRef,
            decisionRef: "decision/2",
            resume: { approved: false },
          },
        }),
        services,
      );

      expect(resumed.result).toMatchObject({ ok: false, reason: "tool_error" });
      expect(executed).toBe(0);
      expect(projectDecisionGate(services.events, first.result.gateRef)).toMatchObject({
        status: "rejected",
      });
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
