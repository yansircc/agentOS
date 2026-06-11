import { Effect, Schema } from "effect";
import { describe, expect, it } from "@effect/vitest";
import {
  llmCallSnapshotFromResponse,
  LlmTransport,
  replayLlmResponseFromSnapshot,
  type LlmRequest,
  type LlmResponse,
  type LlmRoute,
  type LlmWireDescriptor,
} from "@agent-os/llm-protocol";
import type { LedgerEvent } from "@agent-os/kernel/types";
import {
  boundaryPackage,
  defineBoundaryContract,
  type BoundaryContract,
} from "@agent-os/kernel/boundary-contract";
import {
  defineTool,
  externalToolExecution,
  deterministicToolExecution,
  resolveToolExecution,
  withToolReadRequirement,
  withToolWriteRequirement,
} from "@agent-os/kernel/tools";
import { ToolError } from "@agent-os/kernel/errors";
import { Admission } from "../src/admission";
import { BoundaryEvents } from "../src/boundary-events";
import { commitBoundaryEvent } from "../src/boundary-commit";
import { Ledger } from "../src/ledger";
import {
  MaterializedProjections,
  type MaterializedProjectionGetSpec,
  type MaterializedProjectionRow,
} from "../src/projection";
import { Quota } from "../src/quota-service";
import { submitAgentEffect } from "../src/submit-agent";
import {
  RUNTIME_FACT_OWNER,
  decodeRuntimeLedgerEvent,
  EXTERNAL_TOOL_EXECUTION_REQUIRES_RECEIPT_REASON,
  projectFailureDiagnostics,
  replayToolFromArtifact,
  toolReplayArtifactFromExecutedPayload,
  type InternalSubmitSpec,
} from "@agent-os/runtime-protocol";
import { defineSettlementContract } from "@agent-os/kernel/settlement-contract";
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
  const projections = {
    get: (_spec: MaterializedProjectionGetSpec) =>
      Effect.succeed(null as MaterializedProjectionRow | null),
    list: () => Effect.succeed([]),
    status: () =>
      Effect.succeed({
        kind: "test.projection",
        scope: "conversation:submit-runtime-events",
        version: 1,
        status: "current" as const,
        lastAppliedEventId: 0,
        lastRebuiltEventId: null,
        updatedAt: null,
      }),
    rebuild: () =>
      Effect.succeed({
        kind: "test.projection",
        scope: "conversation:submit-runtime-events",
        version: 1,
        status: "current" as const,
        lastAppliedEventId: 0,
        lastRebuiltEventId: 0,
        updatedAt: null,
        rows: 0,
      }),
  };
  return { events, llmRequests, ledger, boundaryEvents, llm, quota, refs, admission, projections };
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
    Effect.provideService(MaterializedProjections, services.projections),
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
  it("replay mode live LLM provider adapter not called when call snapshot is present", () => {
    let liveLlmProviderAdapterCalled = false;
    const liveLlm = {
      resolveRoute: (route: LlmRoute) =>
        Effect.succeed({
          wireDescriptor: testWireDescriptor(route),
          providerOutputAdapterId: "test-provider-output@1.0.0",
          providerOutputAdapterVersion: "1.0.0",
          transportAdapterId: "test-runtime@1.0.0",
          transportAdapterVersion: "1.0.0",
        }),
      call: () =>
        Effect.sync(() => {
          liveLlmProviderAdapterCalled = true;
          return response({ items: [{ type: "message", text: "live" }] });
        }),
    };
    const spec = baseSpec();
    const snapshot = llmCallSnapshotFromResponse({
      wireDescriptor: testWireDescriptor(spec.route),
      request: {
        route: spec.route,
        messages: [{ role: "user", content: "hello" }],
      },
      response: response({ items: [{ type: "message", text: "snapshot" }] }),
    });

    const replayed = replayLlmResponseFromSnapshot(snapshot);

    expect(replayed.items).toEqual([{ type: "message", text: "snapshot" }]);
    expect(liveLlmProviderAdapterCalled).toBe(false);
    expect(liveLlm.call).toBeDefined();
  });

  it.effect("replay mode live tool execute not called when tool result snapshot is present", () =>
    Effect.gen(function* () {
      const tool = defineTool({
        name: "lookup",
        description: "lookup",
        args: Schema.Struct({ q: Schema.String }),
        execute: () => Effect.succeed({ value: "from-run" }),
        authority: "read",
        admit: () => Effect.succeed({ ok: true }),
        execution: deterministicToolExecution(),
      });
      const { events } = yield* runSubmit(baseSpec({ tools: { lookup: tool } }), [
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
        response({ items: [{ type: "message", text: "done" }] }),
      ]);
      let liveToolExecuteCalled = false;
      const liveTool = {
        execute: () => {
          liveToolExecuteCalled = true;
          return Effect.succeed({ value: "live" });
        },
      };
      const toolEvent = events
        .map((event) => decodeRuntimeLedgerEvent(event))
        .find((decoded) => decoded._tag === "runtime" && decoded.event.kind === "tool.executed");
      if (toolEvent?._tag !== "runtime" || toolEvent.event.kind !== "tool.executed") {
        expect.fail("expected tool.executed runtime event");
      }

      const resolvedExecution = resolveToolExecution(toolEvent.event.payload.execution, {
        domains: [],
      });
      if (!resolvedExecution.ok) {
        expect.fail("expected deterministic tool execution to resolve");
      }
      const artifact = toolReplayArtifactFromExecutedPayload(
        toolEvent.event.payload,
        resolvedExecution.resolved,
      );
      if (!artifact.ok) {
        expect.fail("expected deterministic tool result snapshot artifact");
      }
      const replayed = replayToolFromArtifact(artifact.artifact);

      expect(replayed).toMatchObject({ ok: true, result: { value: "from-run" } });
      expect(liveToolExecuteCalled).toBe(false);
      expect(liveTool.execute).toBeDefined();
    }),
  );

  it.effect("does not execute an external tool without a receipt-backed terminal contract", () =>
    Effect.gen(function* () {
      let liveToolExecuteCalled = false;
      const tool = defineTool({
        name: "write_file",
        description: "write file",
        args: Schema.Struct({ path: Schema.String }),
        execute: () => {
          liveToolExecuteCalled = true;
          return withToolWriteRequirement(Effect.succeed({ written: true }));
        },
        authority: "write",
        admit: () => Effect.succeed({ ok: true }),
        execution: externalToolExecution("write", {
          kind: "workspace",
          ref: "workspace:default",
        }),
      });

      const { result, events } = yield* runSubmit(
        baseSpec({
          tools: { write_file: tool },
          executionDomains: [
            {
              domain: { kind: "workspace", ref: "workspace:default" },
              replay: { access: "write", witness: "receipt" },
            },
          ],
        }),
        [
          response({
            items: [
              { type: "message", text: "write file" },
              {
                type: "tool_call",
                call: {
                  id: "call-1",
                  type: "function",
                  function: { name: "write_file", arguments: '{"path":"out.txt"}' },
                },
              },
            ],
          }),
        ],
      );

      expect(result).toMatchObject({ ok: false, reason: "tool_error" });
      expect(liveToolExecuteCalled).toBe(false);
      expect(decodedRuntimeKinds(events)).toEqual([
        "agent.run.started",
        "chat.ingested",
        "llm.response",
        "tool.rejected",
        "agent.aborted.tool_error",
      ]);
      expect(events.some((event) => event.kind === "tool.executed")).toBe(false);
      expect(JSON.stringify(events)).toContain(EXTERNAL_TOOL_EXECUTION_REQUIRES_RECEIPT_REASON);
      expect(projectFailureDiagnostics(events, 1)).toMatchObject({
        diagnostics: [
          {
            source: "tool",
            reason: EXTERNAL_TOOL_EXECUTION_REQUIRES_RECEIPT_REASON,
            category: "missing_execution_path",
            owner: "integrator",
            retryable: false,
            publicMessage: "This tool requires a receipt-backed execution path before it can run.",
          },
        ],
      });
    }),
  );

  it.effect("executes external read tools when the domain law uses snapshot witness", () =>
    Effect.gen(function* () {
      let liveToolExecuteCalled = false;
      const domain = { kind: "workspace" as const, ref: "workspace:default" };
      const tool = defineTool({
        name: "read_file",
        description: "read file",
        args: Schema.Struct({ path: Schema.String }),
        execute: ({ path }) => {
          liveToolExecuteCalled = true;
          return withToolReadRequirement(Effect.succeed({ path, content: "snapshot" }));
        },
        authority: "read",
        admit: () => Effect.succeed({ ok: true }),
        execution: externalToolExecution("read", domain),
      });

      const { result, events } = yield* runSubmit(
        baseSpec({
          tools: { read_file: tool },
          executionDomains: [{ domain, replay: { access: "read", witness: "snapshot" } }],
        }),
        [
          response({
            items: [
              { type: "message", text: "read file" },
              {
                type: "tool_call",
                call: {
                  id: "call-1",
                  type: "function",
                  function: { name: "read_file", arguments: '{"path":"input/editor.json"}' },
                },
              },
            ],
          }),
          response({ items: [{ type: "message", text: "done" }] }),
        ],
      );

      expect(result).toMatchObject({ ok: true });
      expect(liveToolExecuteCalled).toBe(true);
      expect(decodedRuntimeKinds(events)).toContain("tool.executed");
      expect(decodedRuntimeKinds(events)).not.toContain("tool.rejected");

      const toolEvent = events
        .map((event) => decodeRuntimeLedgerEvent(event))
        .find((decoded) => decoded._tag === "runtime" && decoded.event.kind === "tool.executed");
      if (toolEvent?._tag !== "runtime" || toolEvent.event.kind !== "tool.executed") {
        expect.fail("expected tool.executed runtime event");
      }
      const resolved = resolveToolExecution(toolEvent.event.payload.execution, {
        domains: [{ domain, replay: { access: "read", witness: "snapshot" } }],
      });
      if (!resolved.ok) {
        expect.fail("expected external read tool execution to resolve");
      }
      const artifact = toolReplayArtifactFromExecutedPayload(
        toolEvent.event.payload,
        resolved.resolved,
      );
      expect(artifact).toMatchObject({
        ok: true,
        artifact: {
          kind: "tool.result",
          execution: { kind: "external", access: "read", domain },
          result: { path: "input/editor.json", content: "snapshot" },
        },
      });
    }),
  );

  it.effect("injects the tool pre-claim when emitting a declared intent with a claim slot", () =>
    Effect.gen(function* () {
      const intentPackage = boundaryPackage(
        defineBoundaryContract({
          packageId: "@agent-os/runtime-test.claimed-intent",
          kindPrefixes: ["runtime.claimed_intent."],
          roles: ["generator", "reader"],
          events: {
            "runtime.claimed_intent.requested": {
              payloadSchema: {
                type: "object",
                properties: { label: { type: "string" } },
                required: ["label"],
                additionalProperties: false,
              },
              claim: { key: "claim", phase: "pre" },
            },
          },
          effectAuthorityContracts: [],
          materialRequirements: [],
          settlement: defineSettlementContract({
            settlementId: "runtime.claimed_intent.test",
            anchorKinds: ["ledger_event"],
            rejectionKinds: ["validation_failed"],
          }),
          projection: { derivedFromLedger: true, shadowState: false },
        }),
        "0.0.0",
      );
      const tool = defineTool({
        name: "intent",
        description: "intent",
        args: Schema.Struct({ label: Schema.String }),
        execute: (args, ctx) =>
          Effect.gen(function* () {
            if (ctx.emitIntent === undefined) {
              return yield* new ToolError({
                toolName: "intent",
                cause: { reason: "missing_emit_intent" },
              });
            }
            const emitted = yield* ctx.emitIntent("runtime.claimed_intent.requested", {
              label: args.label,
            });
            return { emittedId: emitted.id };
          }),
        authority: "write",
        admit: () => Effect.succeed({ ok: true }),
        execution: deterministicToolExecution(),
      });

      const { result, events } = yield* runSubmit(
        baseSpec({
          tools: { intent: tool },
          toolIntents: [
            {
              kind: "runtime.claimed_intent.requested",
              boundaryPackage: intentPackage,
            },
          ],
        }),
        [
          response({
            items: [
              { type: "message", text: "emit intent" },
              {
                type: "tool_call",
                call: {
                  id: "call-1",
                  type: "function",
                  function: { name: "intent", arguments: '{"label":"abc"}' },
                },
              },
            ],
          }),
          response({ items: [{ type: "message", text: "done" }] }),
        ],
      );

      expect(result).toMatchObject({ ok: true, final: "done" });
      const intentEvent = events.find((event) => event.kind === "runtime.claimed_intent.requested");
      expect(intentEvent?.factOwnerRef).toBe("@agent-os/runtime-test.claimed-intent");
      expect(intentEvent?.payload).toMatchObject({
        label: "abc",
        claim: {
          phase: "pre",
          operationRef: "tool:submit-runtime-events:1:0:call-1",
          scopeRef: { kind: "conversation", scopeId: "submit-runtime-events" },
          effectAuthorityRef: { authorityClass: "write", authorityId: "tool:intent" },
          originRef: { originKind: "submit", originId: "run:1" },
        },
      });
      expect(events.some((event) => event.kind === "tool.rejected")).toBe(false);
    }),
  );

  it.effect("lets tools wait for projections under an explicit truth identity", () =>
    Effect.gen(function* () {
      const projectionScopeRef = {
        kind: "conversation" as const,
        scopeId: "projection-owner-scope",
      };
      const projectionEffectAuthorityRef = {
        authorityClass: "tool" as const,
        authorityId: "projection-writer",
      };
      const projectionFactOwnerRef = "@agent-os/runtime-test.projection-owner" as const;
      let observedProjectionSpec:
        | {
            readonly kind: string;
            readonly scopeRef: unknown;
            readonly effectAuthorityRef: unknown;
            readonly factOwnerRef: unknown;
            readonly identity: unknown;
          }
        | undefined;
      const tool = defineTool({
        name: "await_projection",
        description: "wait projection",
        args: Schema.Struct({ id: Schema.String }),
        execute: (args, ctx) =>
          Effect.gen(function* () {
            if (ctx.awaitProjection === undefined) {
              return yield* new ToolError({
                toolName: "await_projection",
                cause: { reason: "missing_await_projection" },
              });
            }
            const row = yield* ctx.awaitProjection<{ readonly ok: boolean }>({
              kind: "runtime.test.projection",
              scopeRef: projectionScopeRef,
              effectAuthorityRef: projectionEffectAuthorityRef,
              factOwnerRef: projectionFactOwnerRef,
              identity: { id: args.id },
              maxAttempts: 1,
            });
            return { identityKey: row.identityKey, state: row.state };
          }),
        authority: "read",
        admit: () => Effect.succeed({ ok: true }),
        execution: deterministicToolExecution(),
      });
      const services = makeServices([
        response({
          items: [
            {
              type: "tool_call",
              call: {
                id: "call-1",
                type: "function",
                function: { name: "await_projection", arguments: '{"id":"intent-1"}' },
              },
            },
          ],
        }),
        response({ items: [{ type: "message", text: "projected" }] }),
      ]);
      services.projections.get = (spec) =>
        Effect.sync(() => {
          observedProjectionSpec = spec;
          return {
            kind: spec.kind,
            scope: "conversation:projection-owner-scope",
            identityKey: "intent-1",
            identity: spec.identity,
            state: { ok: true },
            version: 1,
            updatedEventId: 42,
            updatedAt: 420,
          };
        });

      const { result, events } = yield* runSubmitWithServices(
        baseSpec({ tools: { await_projection: tool }, budget: { maxTurns: 2 } }),
        services,
      );

      expect(result).toMatchObject({ ok: true, final: "projected" });
      expect(observedProjectionSpec).toMatchObject({
        kind: "runtime.test.projection",
        scopeRef: projectionScopeRef,
        effectAuthorityRef: projectionEffectAuthorityRef,
        factOwnerRef: projectionFactOwnerRef,
        identity: { id: "intent-1" },
      });
      expect(events.find((event) => event.kind === "tool.executed")?.payload).toMatchObject({
        result: { identityKey: "intent-1", state: { ok: true } },
      });
    }),
  );

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
        execute: () => Effect.succeed({ ok: true }),
        authority: "read",
        admit: () =>
          Effect.succeed({
            ok: false,
            rejectionRef: {
              rejectionId: "lookup-denied",
              rejectionKind: "policy_denied",
              reason: "denied",
            },
          }),
        execution: deterministicToolExecution(),
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

  it.effect("known tool schema decode failure emits tool.rejected diagnostics before abort", () =>
    Effect.gen(function* () {
      const tool = defineTool({
        name: "write_file",
        description: "write file",
        args: Schema.Struct({ path: Schema.String, content: Schema.String }),
        execute: () => Effect.succeed({ ok: true }),
        authority: "write",
        admit: () => Effect.succeed({ ok: true }),
        execution: deterministicToolExecution(),
      });

      const { result, events } = yield* runSubmit(baseSpec({ tools: { write_file: tool } }), [
        response({
          items: [
            { type: "message", text: "write" },
            {
              type: "tool_call",
              call: {
                id: "call-1",
                type: "function",
                function: { name: "write_file", arguments: '{"path":"out.txt"}' },
              },
            },
          ],
        }),
      ]);

      expect(result).toMatchObject({ ok: false, reason: "tool_error" });
      expect(decodedRuntimeKinds(events)).toEqual([
        "agent.run.started",
        "chat.ingested",
        "llm.response",
        "tool.rejected",
        "agent.aborted.tool_error",
      ]);
      const rejected = events.find((event) => event.kind === "tool.rejected");
      expect(decodeRuntimeLedgerEvent(rejected!)).toMatchObject({
        _tag: "runtime",
        event: {
          payload: {
            name: "write_file",
            diagnostics: {
              phase: "decode",
              reason: "invalid_args",
              argumentSummary: { type: "object", keys: ["path"], truncated: false },
            },
          },
        },
      });
      const diagnostics = projectFailureDiagnostics(events, 1);
      expect(JSON.stringify(diagnostics)).toContain("content");
      expect(JSON.stringify(diagnostics)).not.toContain("out.txt");
    }),
  );

  it.effect("known tool JSON parse failure emits tool.rejected diagnostics before abort", () =>
    Effect.gen(function* () {
      const tool = defineTool({
        name: "lookup",
        description: "lookup",
        args: Schema.Struct({ q: Schema.String }),
        execute: () => Effect.succeed({ ok: true }),
        authority: "read",
        admit: () => Effect.succeed({ ok: true }),
        execution: deterministicToolExecution(),
      });

      const { result, events } = yield* runSubmit(baseSpec({ tools: { lookup: tool } }), [
        response({
          items: [
            { type: "message", text: "lookup" },
            {
              type: "tool_call",
              call: {
                id: "call-1",
                type: "function",
                function: { name: "lookup", arguments: '{"q":' },
              },
            },
          ],
        }),
      ]);

      expect(result).toMatchObject({ ok: false, reason: "tool_error" });
      expect(decodedRuntimeKinds(events)).toEqual([
        "agent.run.started",
        "chat.ingested",
        "llm.response",
        "tool.rejected",
        "agent.aborted.tool_error",
      ]);
      expect(projectFailureDiagnostics(events, 1)).toMatchObject({
        diagnostics: [
          {
            source: "tool",
            phase: "parse",
            reason: "invalid_args",
            toolName: "lookup",
            toolCallId: "call-1",
          },
        ],
      });
    }),
  );

  it.effect("unknown tool remains terminal-only diagnostics without a fabricated claim", () =>
    Effect.gen(function* () {
      const { result, events } = yield* runSubmit(baseSpec(), [
        response({
          items: [
            { type: "message", text: "missing" },
            {
              type: "tool_call",
              call: {
                id: "call-1",
                type: "function",
                function: { name: "missing_tool", arguments: "{}" },
              },
            },
          ],
        }),
      ]);

      expect(result).toMatchObject({ ok: false, reason: "tool_error" });
      expect(events.some((event) => event.kind === "tool.rejected")).toBe(false);
      expect(projectFailureDiagnostics(events, 1)).toMatchObject({
        diagnostics: [
          {
            source: "run",
            phase: "terminal",
            reason: "unknown_tool",
            toolName: "missing_tool",
          },
        ],
      });
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
          return Effect.succeed({ applied: true });
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
        admit: () => Effect.succeed({ ok: true }),
        execution: deterministicToolExecution(),
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
          return Effect.succeed({ applied: true });
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
        admit: () => Effect.succeed({ ok: true }),
        execution: deterministicToolExecution(),
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

  it.effect("rejects non-symbolic material values before resolver lookup", () =>
    Effect.gen(function* () {
      let executed = false;
      const tool = defineTool({
        name: "apply",
        description: "apply",
        args: Schema.Struct({ title: Schema.String }),
        execute: () => {
          executed = true;
          return Effect.succeed({ applied: true });
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
        admit: () => Effect.succeed({ ok: true }),
        execution: deterministicToolExecution(),
      });

      const resolvedProviderMaterial = {
        kind: "credential",
        ref: "WP_TOKEN",
        provider: "wordpress",
        purpose: "apply",
        value: "secret-token-value",
      };

      const { result, events } = yield* runSubmit(
        baseSpec({
          tools: { apply: tool },
          materials: {
            wp_token: resolvedProviderMaterial,
          } as unknown as InternalSubmitSpec["materials"],
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
      expect(JSON.stringify(rejected?.payload)).toContain("material_invalid:wp_token");
      expect(JSON.stringify(events)).not.toContain("secret-token-value");
    }),
  );

  it.effect("uses submit-scoped resolved material values without resolver lookup", () =>
    Effect.gen(function* () {
      let executed = false;
      const tool = defineTool({
        name: "apply",
        description: "Apply a post",
        args: Schema.Struct({ title: Schema.String }),
        execute: (_args, ctx) => {
          executed = ctx.materials.wp_token === "secret-token-value";
          return Effect.succeed({ applied: true });
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
        admit: () => Effect.succeed({ ok: true }),
        execution: deterministicToolExecution(),
      });

      const tokenRef = credentialMaterialRef("run-wp-token", {
        provider: "wordpress",
        purpose: "apply",
      });

      const { result, events } = yield* runSubmit(
        baseSpec({
          tools: { apply: tool },
          materials: { wp_token: tokenRef },
          resolvedMaterials: { wp_token: "secret-token-value" },
          budget: { maxTurns: 2 },
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
          response({ items: [{ type: "message", text: "applied" }] }),
        ],
      );

      expect(result).toMatchObject({ ok: true, final: "applied" });
      expect(executed).toBe(true);
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
          return Effect.succeed({ ok: true });
        },
        authority: "write",
        admit: () => Effect.succeed({ ok: true }),
        execution: deterministicToolExecution(),
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
          return Effect.succeed({ applied: true });
        },
        authority: "write",
        admit: () => Effect.succeed({ ok: true }),
        execution: deterministicToolExecution(),
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
          return Effect.succeed({ applied: true });
        },
        authority: "write",
        admit: () => Effect.succeed({ ok: true }),
        execution: deterministicToolExecution(),
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

  it.effect("passes approved resume payload to the resumed tool call only", () =>
    Effect.gen(function* () {
      let observedResume: unknown;
      const tool = defineTool({
        name: "askUserQuestions",
        description: "ask for input",
        args: Schema.Struct({ question: Schema.String }),
        execute: (_args, ctx) => {
          observedResume = ctx.resume;
          return Effect.succeed({ kind: "user_input_received", resume: ctx.resume });
        },
        authority: "read",
        admit: () => Effect.succeed({ ok: true }),
        execution: deterministicToolExecution(),
      });
      const services = makeServices([
        response({
          items: [
            { type: "message", text: "need input" },
            {
              type: "tool_call",
              call: {
                id: "call-questions",
                type: "function",
                function: {
                  name: "askUserQuestions",
                  arguments: '{"question":"What should change?"}',
                },
              },
            },
          ],
        }),
        response({ items: [{ type: "message", text: "answered" }] }),
      ]);

      const first = yield* runSubmitWithServices(
        baseSpec({
          tools: { askUserQuestions: tool },
          decisionInterrupts: [{ toolName: "askUserQuestions", reason: "user_input_required" }],
        }),
        services,
      );
      if (first.result.status !== "interrupted") {
        expect.fail("expected interrupted result");
      }
      expect(observedResume).toBeUndefined();

      yield* services.boundaryEvents.commit(
        decisionGateBoundaryContract,
        DECISION_GATE_KIND.DECIDED,
        {
          gateRef: first.result.gateRef,
          decisionRef: "decision/answers",
          decision: "approved",
          decidedBy: "operator/alice",
        },
      );

      const resume = { answers: { site_style: "clean" } };
      const resumed = yield* runSubmitWithServices(
        baseSpec({
          tools: { askUserQuestions: tool },
          resume: {
            runId: first.result.runId,
            turn: first.result.turn,
            interruptId: first.result.interruptId,
            gateRef: first.result.gateRef,
            decisionRef: "decision/answers",
            resume,
          },
        }),
        services,
      );

      expect(resumed.result).toMatchObject({ ok: true, final: "answered" });
      expect(observedResume).toEqual(resume);
      const executed = services.events.find((event) => event.kind === "tool.executed");
      expect(executed?.payload).toMatchObject({
        result: { kind: "user_input_received", resume },
      });
    }),
  );

  it.effect("propagates trace context through LLM request and runtime facts only", () =>
    Effect.gen(function* () {
      const tool = defineTool({
        name: "lookup",
        description: "lookup",
        args: Schema.Struct({ q: Schema.String }),
        execute: () => Effect.succeed({ ok: true }),
        authority: "read",
        admit: () => Effect.succeed({ ok: true }),
        execution: deterministicToolExecution(),
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
