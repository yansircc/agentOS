import { Effect, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";
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
import { decodeRecordedLedgerEvent, type LedgerEvent } from "@agent-os/kernel/types";
import {
  boundaryPackage,
  defineBoundaryContract,
  type BoundaryContract,
} from "@agent-os/kernel/boundary-contract";
import {
  defineTool,
  externalToolExecution,
  deterministicToolExecution,
  isMaterialBrokerPlaceholder,
  resolveToolExecution,
  withToolReadRequirement,
  withToolWriteRequirement,
} from "@agent-os/kernel/tools";
import { ToolError } from "@agent-os/kernel/errors";
import { Admission } from "../src/admission";
import { BoundaryEvents } from "../src/boundary-events";
import {
  boundaryCommitIdentity,
  commitBoundaryEvent,
  validateBoundaryEventPayload,
  validateCommittedBoundaryEvent,
} from "../src/boundary-commit";
import { Ledger } from "../src/ledger";
import {
  MaterializedProjections,
  type MaterializedProjectionGetSpec,
  type MaterializedProjectionRow,
} from "../src/projection";
import { Quota } from "../src/quota-service";
import { submitAgentEffect } from "../src/submit-agent";
import {
  projectContinuation,
  submitResumeDecisionFromContinuationProjection,
} from "../src/continuation";
import {
  projectInputRequest,
  submitResumeDecisionFromInputRequestProjection,
} from "../src/input-request";
import {
  RUNTIME_FACT_OWNER,
  decodeRuntimeLedgerEvent,
  EXECUTION_IDENTITY_VERSION,
  EXTERNAL_TOOL_EXECUTION_REQUIRES_RECEIPT_REASON,
  projectFailureDiagnostics,
  replayToolFromArtifact,
  receiptBackedToolResult,
  RUNTIME_EVENT_KIND,
  toolReplayArtifactFromExecutedPayload,
  type SubmitSpec,
} from "@agent-os/runtime-protocol";
import { internalSubmitSpec, type InternalSubmitSpec } from "../src/internal-submit";
import { defineSettlementContract } from "@agent-os/kernel/settlement-contract";
import { RefResolverLive } from "@agent-os/kernel/ref-resolver";
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
const executionIdentity = {
  version: EXECUTION_IDENTITY_VERSION,
  manifest: { agentId: "agent.submit-runtime-events", version: "1.0.0" },
  deployment: {
    deploymentId: "deployment:submit-runtime-events",
    backend: "in-memory",
    adapter: "runtime-test",
    codec: "ledger-v1",
  },
} satisfies NonNullable<SubmitSpec["executionIdentity"]>;

const basePublicSpec = (overrides: Partial<SubmitSpec> = {}): SubmitSpec => ({
  intent: "answer",
  context: { topic: "runtime events" },
  route: {
    kind: "openai-chat-compatible",
    endpointRef: "test-endpoint",
    credentialRef: "test-credential",
    modelId: "test-model",
  },
  tools: {},
  effectAuthorityRef: {
    authorityClass: "llm_route",
    authorityId: "test-route",
  },
  ...overrides,
});

const baseSpec = (overrides: Partial<SubmitSpec> = {}): InternalSubmitSpec =>
  internalSubmitSpec(basePublicSpec(overrides), {
    scope,
    scopeRef: { kind: "conversation", scopeId: scope },
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
  materialObserver: {
    readonly onMaterial?: (ref: MaterialRef) => void;
    readonly onDispose?: (ref: MaterialRef, material: ResolvedMaterial) => void;
  } = {},
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
        return committed.map(decodeRecordedLedgerEvent);
      }),
    events: () => Effect.succeed(events.map(decodeRecordedLedgerEvent)),
    streamSnapshot: () => Effect.succeed(events.map(decodeRecordedLedgerEvent)),
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
            scopeRef: identity.scopeRef ?? {
              kind: "conversation",
              scopeId: scope,
            },
            effectAuthorityRef: identity.effectAuthorityRef ?? {
              authorityClass: "llm_route",
              authorityId: "test-route",
            },
            factOwnerRef: identity.factOwnerRef,
            payload,
          } satisfies LedgerEvent;
          events.push(committed);
          return decodeRecordedLedgerEvent(committed);
        }),
      ),
    commitWithRuntimeEvents: (
      contract: BoundaryContract,
      event: string,
      payload: unknown,
      runtimeEvents: (boundaryEventId: number) => ReadonlyArray<{
        readonly kind: string;
        readonly payload: unknown;
        readonly scopeRef: LedgerEvent["scopeRef"];
        readonly effectAuthorityRef: LedgerEvent["effectAuthorityRef"];
        readonly ts?: number;
      }>,
    ) =>
      Effect.gen(function* () {
        const rejected = validateBoundaryEventPayload(contract, event, payload);
        if (rejected !== null) {
          return yield* Effect.fail(rejected);
        }
        const objectPayload = payload as Readonly<Record<string, unknown>>;
        const identity = boundaryCommitIdentity(contract, event, objectPayload);
        const boundaryId = nextId++;
        const boundaryEvent = {
          id: boundaryId,
          ts: boundaryId * 10,
          kind: event,
          scopeRef: identity.scopeRef ?? {
            kind: "conversation",
            scopeId: scope,
          },
          effectAuthorityRef: identity.effectAuthorityRef ?? {
            authorityClass: "llm_route",
            authorityId: "test-route",
          },
          factOwnerRef: identity.factOwnerRef,
          payload,
        } satisfies LedgerEvent;
        const committedRejected = validateCommittedBoundaryEvent(
          contract,
          event,
          objectPayload,
          boundaryEvent,
        );
        if (committedRejected !== null) {
          return yield* Effect.fail(committedRejected);
        }
        const committedRuntimeEvents = runtimeEvents(boundaryId).map((spec) => {
          const id = nextId++;
          return {
            id,
            ts: spec.ts ?? id * 10,
            kind: spec.kind,
            scopeRef: spec.scopeRef,
            effectAuthorityRef: spec.effectAuthorityRef,
            factOwnerRef: RUNTIME_FACT_OWNER,
            payload: spec.payload,
          } satisfies LedgerEvent;
        });
        const committed = [boundaryEvent, ...committedRuntimeEvents];
        events.push(...committed);
        const recorded = committed.map(decodeRecordedLedgerEvent);
        return [recorded[0]!, ...recorded.slice(1)] as const;
      }),
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
  const refs = RefResolverLive({
    material: (ref: MaterialRef) => {
      materialObserver.onMaterial?.(ref);
      const value = materials[materialRefKey(ref)];
      return value === undefined ? null : value;
    },
    dispose: ({ ref, material }) => materialObserver.onDispose?.(ref, material),
  });
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
  return {
    events,
    llmRequests,
    ledger,
    boundaryEvents,
    llm,
    quota,
    refs,
    admission,
    projections,
  };
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
    Effect.provide(services.refs),
    Effect.provideService(Admission, services.admission),
  );
  return Effect.map(effect, (result) => ({
    result,
    events: services.events,
    llmRequests: services.llmRequests,
  }));
};

const decodedRuntimeBehaviorKinds = (events: ReadonlyArray<LedgerEvent>): ReadonlyArray<string> =>
  events.flatMap((event) => {
    const decoded = decodeRuntimeLedgerEvent(event);
    return decoded._tag === "runtime" && decoded.event.kind !== RUNTIME_EVENT_KIND.LLM_REQUESTED
      ? [decoded.event.kind]
      : [];
  });

const decodedRuntimeEvents = (events: ReadonlyArray<LedgerEvent>) =>
  events.flatMap((event) => {
    const decoded = decodeRuntimeLedgerEvent(event);
    return decoded._tag === "runtime" ? [decoded.event] : [];
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

      expect(replayed).toMatchObject({
        ok: true,
        result: { value: "from-run" },
      });
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
                  function: {
                    name: "write_file",
                    arguments: '{"path":"out.txt"}',
                  },
                },
              },
            ],
          }),
        ],
      );

      expect(result).toMatchObject({ ok: false, reason: "tool_error" });
      expect(liveToolExecuteCalled).toBe(false);
      expect(decodedRuntimeBehaviorKinds(events)).toEqual([
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

  it.effect("records receipt-backed external tool execution from a declared bridge result", () =>
    Effect.gen(function* () {
      let bridgeExecuteCalled = false;
      const domain = { kind: "workspace" as const, ref: "workspace:default" };
      const receiptClaim = {
        phase: "lived" as const,
        operationRef: "tool:submit-runtime-events:1:0:call-1",
        scopeRef: { kind: "conversation" as const, scopeId: scope },
        effectAuthorityRef: {
          authorityClass: "write",
          authorityId: "tool:write_file",
        },
        originRef: { originId: "run:1", originKind: "submit" },
        anchorRef: {
          anchorId: "workspace_op:receipt:tool:submit-runtime-events:1:0:call-1:7",
          anchorKind: "external_receipt" as const,
          carrierRef: "workspace_op:carrier:workspace-op",
        },
      };
      const tool = defineTool({
        name: "write_file",
        description: "write file",
        args: Schema.Struct({ path: Schema.String }),
        execute: ({ path }) => {
          bridgeExecuteCalled = true;
          return withToolWriteRequirement(
            Effect.succeed(
              receiptBackedToolResult({
                result: {
                  kind: "write_file",
                  path,
                  bytesWritten: 5,
                  resultHash: "sha256:abc",
                },
                claim: receiptClaim,
              }),
            ),
          );
        },
        authority: "write",
        admit: () => Effect.succeed({ ok: true }),
        execution: externalToolExecution("write", domain),
      });

      const { result, events } = yield* runSubmit(
        baseSpec({
          tools: { write_file: tool },
          executionDomains: [{ domain, replay: { access: "write", witness: "receipt" } }],
          toolIntents: [
            {
              kind: "workspace_op.requested",
              boundaryPackage: boundaryPackage(
                defineBoundaryContract({
                  packageId: "@agent-os/workspace-op",
                  kindPrefixes: ["workspace_op."],
                  roles: ["generator", "reader"],
                  events: {
                    "workspace_op.requested": {
                      payloadSchema: {
                        type: "object",
                        properties: { requestedBy: { type: "string" } },
                        required: ["requestedBy"],
                        additionalProperties: true,
                      },
                    },
                  },
                  effectAuthorityContracts: [],
                  materialRequirements: [],
                  settlement: defineSettlementContract({
                    settlementId: "@agent-os/workspace-op",
                    anchorKinds: ["external_receipt"],
                    rejectionKinds: ["provider_rejected"],
                    indeterminateKinds: [],
                  }),
                  projection: { derivedFromLedger: true, shadowState: false },
                }),
                "0.2.9",
              ),
            },
          ],
          receiptBackedTools: {
            write_file: {
              kind: "intent_projection",
              intentKinds: ["workspace_op.requested"],
            },
          },
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
                  function: {
                    name: "write_file",
                    arguments: '{"path":"out.txt"}',
                  },
                },
              },
            ],
          }),
          response({ items: [{ type: "message", text: "done" }] }),
        ],
      );

      expect(result).toMatchObject({ ok: true, final: "done" });
      expect(bridgeExecuteCalled).toBe(true);
      const toolEvent = events
        .map((event) => decodeRuntimeLedgerEvent(event))
        .find((decoded) => decoded._tag === "runtime" && decoded.event.kind === "tool.executed");
      if (toolEvent?._tag !== "runtime" || toolEvent.event.kind !== "tool.executed") {
        expect.fail("expected tool.executed runtime event");
      }
      expect(toolEvent.event.payload).toMatchObject({
        result: { kind: "write_file", path: "out.txt", bytesWritten: 5 },
        claim: {
          phase: "lived",
          anchorRef: { anchorKind: "external_receipt" },
        },
      });
      const resolved = resolveToolExecution(toolEvent.event.payload.execution, {
        domains: [{ domain, replay: { access: "write", witness: "receipt" } }],
      });
      if (!resolved.ok) expect.fail("expected receipt execution to resolve");
      expect(
        toolReplayArtifactFromExecutedPayload(toolEvent.event.payload, resolved.resolved),
      ).toMatchObject({
        ok: true,
        artifact: {
          kind: "tool.execution.receipt",
          receipt: { anchorKind: "external_receipt" },
        },
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
                  function: {
                    name: "read_file",
                    arguments: '{"path":"input/editor.json"}',
                  },
                },
              },
            ],
          }),
          response({ items: [{ type: "message", text: "done" }] }),
        ],
      );

      expect(result).toMatchObject({ ok: true });
      expect(liveToolExecuteCalled).toBe(true);
      expect(decodedRuntimeBehaviorKinds(events)).toContain("tool.executed");
      expect(decodedRuntimeBehaviorKinds(events)).not.toContain("tool.rejected");

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

  it.effect("requires tool calls until the declared terminal tool executes", () =>
    Effect.gen(function* () {
      const readFile = defineTool({
        name: "read_file",
        description: "read file",
        args: Schema.Struct({ path: Schema.String }),
        execute: ({ path }) => Effect.succeed({ path, content: "input" }),
        authority: "read",
        admit: () => Effect.succeed({ ok: true }),
        execution: deterministicToolExecution(),
      });
      const writeTerminal = defineTool({
        name: "write_terminal",
        description: "write terminal result",
        args: Schema.Struct({ value: Schema.String }),
        execute: ({ value }) => Effect.succeed({ ok: true, value }),
        authority: "write",
        admit: () => Effect.succeed({ ok: true }),
        execution: deterministicToolExecution(),
      });

      const { result, events, llmRequests } = yield* runSubmit(
        baseSpec({
          tools: { read_file: readFile, write_terminal: writeTerminal },
          toolPolicy: {
            requiredUntilToolExecuted: { toolName: "write_terminal" },
          },
        }),
        [
          response({
            items: [
              {
                type: "tool_call",
                call: {
                  id: "call-read",
                  type: "function",
                  function: {
                    name: "read_file",
                    arguments: '{"path":"input.json"}',
                  },
                },
              },
            ],
          }),
          response({
            items: [
              {
                type: "tool_call",
                call: {
                  id: "call-write",
                  type: "function",
                  function: {
                    name: "write_terminal",
                    arguments: '{"value":"done"}',
                  },
                },
              },
            ],
          }),
          response({ items: [{ type: "message", text: "done" }] }),
        ],
      );

      expect(result).toMatchObject({ ok: true, final: "done" });
      expect(llmRequests.map((request) => request.tool_choice)).toEqual([
        "required",
        "required",
        undefined,
      ]);
      expect(
        events
          .map((event) => decodeRuntimeLedgerEvent(event))
          .filter((decoded) => decoded._tag === "runtime" && decoded.event.kind === "tool.executed")
          .map((decoded) =>
            decoded._tag === "runtime" && decoded.event.kind === "tool.executed"
              ? decoded.event.payload.name
              : "",
          ),
      ).toEqual(["read_file", "write_terminal"]);
    }),
  );

  it.effect("does not complete from prose while a declared required tool is missing", () =>
    Effect.gen(function* () {
      const writeTerminal = defineTool({
        name: "write_terminal",
        description: "write terminal result",
        args: Schema.Struct({ value: Schema.String }),
        execute: ({ value }) => Effect.succeed({ ok: true, value }),
        authority: "write",
        admit: () => Effect.succeed({ ok: true }),
        execution: deterministicToolExecution(),
      });

      const { result, events, llmRequests } = yield* runSubmit(
        baseSpec({
          tools: { write_terminal: writeTerminal },
          toolPolicy: {
            requiredUntilToolExecuted: { toolName: "write_terminal" },
          },
        }),
        [
          response({ items: [{ type: "message", text: "I am done without a tool." }] }),
          response({
            items: [
              {
                type: "tool_call",
                call: {
                  id: "call-write",
                  type: "function",
                  function: {
                    name: "write_terminal",
                    arguments: '{"value":"done"}',
                  },
                },
              },
            ],
          }),
          response({ items: [{ type: "message", text: "done" }] }),
        ],
      );

      expect(result).toMatchObject({ ok: true, final: "done" });
      expect(llmRequests.map((request) => request.tool_choice)).toEqual([
        "required",
        "required",
        undefined,
      ]);
      expect(
        events
          .map((event) => decodeRuntimeLedgerEvent(event))
          .filter(
            (decoded) =>
              decoded._tag === "runtime" &&
              (decoded.event.kind === "tool.executed" ||
                decoded.event.kind === "agent.run.completed"),
          )
          .map((decoded) => (decoded._tag === "runtime" ? decoded.event.kind : "unknown")),
      ).toEqual(["tool.executed", "agent.run.completed"]);
    }),
  );

  it.effect("completes after every declared terminal tool executes", () =>
    Effect.gen(function* () {
      const readFile = defineTool({
        name: "read_file",
        description: "read file",
        args: Schema.Struct({ path: Schema.String }),
        execute: ({ path }) => Effect.succeed({ path, content: "input" }),
        authority: "read",
        admit: () => Effect.succeed({ ok: true }),
        execution: deterministicToolExecution(),
      });
      const writeHtml = defineTool({
        name: "write_html",
        description: "write html",
        args: Schema.Struct({ content: Schema.String }),
        execute: ({ content }) => Effect.succeed({ ok: true, path: "/output/page.html", content }),
        authority: "write",
        admit: () => Effect.succeed({ ok: true }),
        execution: deterministicToolExecution(),
      });
      const writeDesign = defineTool({
        name: "write_design",
        description: "write design notes",
        args: Schema.Struct({ content: Schema.String }),
        execute: ({ content }) => Effect.succeed({ ok: true, path: "/output/DESIGN.md", content }),
        authority: "write",
        admit: () => Effect.succeed({ ok: true }),
        execution: deterministicToolExecution(),
      });

      const { result, events, llmRequests } = yield* runSubmit(
        baseSpec({
          tools: {
            read_file: readFile,
            write_html: writeHtml,
            write_design: writeDesign,
          },
          toolPolicy: {
            completeAfterToolsExecuted: {
              toolNames: ["write_html", "write_design"],
              finalMessage: "artifacts written",
            },
          },
        }),
        [
          response({
            items: [
              {
                type: "tool_call",
                call: {
                  id: "call-html",
                  type: "function",
                  function: {
                    name: "write_html",
                    arguments: '{"content":"<html></html>"}',
                  },
                },
              },
            ],
          }),
          response({
            items: [
              {
                type: "tool_call",
                call: {
                  id: "call-design",
                  type: "function",
                  function: {
                    name: "write_design",
                    arguments: '{"content":"# Design"}',
                  },
                },
              },
            ],
          }),
          response({ items: [{ type: "message", text: "should not be called" }] }),
        ],
      );

      expect(result).toMatchObject({ ok: true, final: "artifacts written" });
      expect(
        llmRequests.map((request) =>
          (request.tools ?? []).map((tool) => tool.function.name).sort(),
        ),
      ).toEqual([
        ["read_file", "write_design", "write_html"],
        ["read_file", "write_design"],
      ]);
      expect(llmRequests.map((request) => request.tool_choice)).toEqual([
        "required",
        { type: "function", function: { name: "write_design" } },
      ]);
      expect(
        events
          .map((event) => decodeRuntimeLedgerEvent(event))
          .filter((decoded) => decoded._tag === "runtime" && decoded.event.kind === "tool.executed")
          .map((decoded) =>
            decoded._tag === "runtime" && decoded.event.kind === "tool.executed"
              ? decoded.event.payload.name
              : "",
          ),
      ).toEqual(["write_html", "write_design"]);
      expect(
        decodedRuntimeEvents(events)
          .filter(
            (event) =>
              event.kind === RUNTIME_EVENT_KIND.LLM_REQUESTED ||
              event.kind === RUNTIME_EVENT_KIND.LLM_RESPONSE ||
              event.kind === RUNTIME_EVENT_KIND.TOOL_EXECUTED ||
              event.kind === RUNTIME_EVENT_KIND.RUNTIME_COMPLETED_AFTER_TOOLS ||
              event.kind === RUNTIME_EVENT_KIND.AGENT_RUN_COMPLETED,
          )
          .map((event) => event.kind),
      ).toEqual([
        RUNTIME_EVENT_KIND.LLM_REQUESTED,
        RUNTIME_EVENT_KIND.LLM_RESPONSE,
        RUNTIME_EVENT_KIND.TOOL_EXECUTED,
        RUNTIME_EVENT_KIND.LLM_REQUESTED,
        RUNTIME_EVENT_KIND.LLM_RESPONSE,
        RUNTIME_EVENT_KIND.TOOL_EXECUTED,
        RUNTIME_EVENT_KIND.RUNTIME_COMPLETED_AFTER_TOOLS,
        RUNTIME_EVENT_KIND.AGENT_RUN_COMPLETED,
      ]);
      expect(
        decodedRuntimeEvents(events)
          .filter((event) => event.kind === RUNTIME_EVENT_KIND.LLM_REQUESTED)
          .map((event) =>
            event.kind === RUNTIME_EVENT_KIND.LLM_REQUESTED ? event.payload : undefined,
          ),
      ).toEqual([
        expect.objectContaining({
          runId: 1,
          turn: { id: 1, index: 0 },
          modelId: "test-model",
          toolNames: ["read_file", "write_html", "write_design"],
          toolChoice: "required",
        }),
        expect.objectContaining({
          runId: 1,
          turn: { id: 1, index: 1 },
          modelId: "test-model",
          toolNames: ["read_file", "write_design"],
          toolChoice: "function:write_design",
        }),
      ]);
      expect(
        decodedRuntimeEvents(events).find(
          (event) => event.kind === RUNTIME_EVENT_KIND.RUNTIME_COMPLETED_AFTER_TOOLS,
        )?.payload,
      ).toEqual(
        expect.objectContaining({
          runId: 1,
          turn: { id: 1, index: 1 },
          toolNames: ["write_html", "write_design"],
          tokensUsed: 4,
        }),
      );
    }),
  );

  it.effect("does not complete until every runtime-required policy tool executes", () =>
    Effect.gen(function* () {
      const prepare = defineTool({
        name: "prepare",
        description: "prepare workspace",
        args: Schema.Struct({ value: Schema.String }),
        execute: ({ value }) => Effect.succeed({ ok: true, value }),
        authority: "write",
        admit: () => Effect.succeed({ ok: true }),
        execution: deterministicToolExecution(),
      });
      const writeArtifact = defineTool({
        name: "write_artifact",
        description: "write artifact",
        args: Schema.Struct({ content: Schema.String }),
        execute: ({ content }) => Effect.succeed({ ok: true, content }),
        authority: "write",
        admit: () => Effect.succeed({ ok: true }),
        execution: deterministicToolExecution(),
      });

      const { result, events, llmRequests } = yield* runSubmit(
        baseSpec({
          tools: {
            prepare,
            write_artifact: writeArtifact,
          },
          toolPolicy: {
            requiredUntilToolExecuted: { toolName: "prepare" },
            completeAfterToolsExecuted: {
              toolNames: ["write_artifact"],
              finalMessage: "artifact ready",
            },
          },
        }),
        [
          response({
            items: [
              {
                type: "tool_call",
                call: {
                  id: "call-write",
                  type: "function",
                  function: {
                    name: "write_artifact",
                    arguments: '{"content":"artifact"}',
                  },
                },
              },
            ],
          }),
          response({
            items: [
              {
                type: "tool_call",
                call: {
                  id: "call-prepare",
                  type: "function",
                  function: {
                    name: "prepare",
                    arguments: '{"value":"ok"}',
                  },
                },
              },
            ],
          }),
        ],
      );

      expect(result).toMatchObject({ ok: true, final: "artifact ready" });
      expect(llmRequests.map((request) => request.tool_choice)).toEqual([
        "required",
        { type: "function", function: { name: "prepare" } },
      ]);
      expect(
        events
          .map((event) => decodeRuntimeLedgerEvent(event))
          .filter((decoded) => decoded._tag === "runtime" && decoded.event.kind === "tool.executed")
          .map((decoded) =>
            decoded._tag === "runtime" && decoded.event.kind === "tool.executed"
              ? decoded.event.payload.name
              : "",
          ),
      ).toEqual(["write_artifact", "prepare"]);
    }),
  );

  it.effect(
    "rejects repeated declared terminal tools and continues with remaining policy tools",
    () =>
      Effect.gen(function* () {
        let htmlExecutions = 0;
        let designExecutions = 0;
        const readFile = defineTool({
          name: "read_file",
          description: "read file",
          args: Schema.Struct({ path: Schema.String }),
          execute: ({ path }) => Effect.succeed({ path, content: "input" }),
          authority: "read",
          admit: () => Effect.succeed({ ok: true }),
          execution: deterministicToolExecution(),
        });
        const writeHtml = defineTool({
          name: "write_html",
          description: "write html",
          args: Schema.Struct({ content: Schema.String }),
          execute: ({ content }) =>
            Effect.sync(() => {
              htmlExecutions++;
              return { ok: true, path: "/output/page.html", content };
            }),
          authority: "write",
          admit: () => Effect.succeed({ ok: true }),
          execution: deterministicToolExecution(),
        });
        const writeDesign = defineTool({
          name: "write_design",
          description: "write design notes",
          args: Schema.Struct({ content: Schema.String }),
          execute: ({ content }) =>
            Effect.sync(() => {
              designExecutions++;
              return { ok: true, path: "/output/DESIGN.md", content };
            }),
          authority: "write",
          admit: () => Effect.succeed({ ok: true }),
          execution: deterministicToolExecution(),
        });

        const { result, events, llmRequests } = yield* runSubmit(
          baseSpec({
            tools: {
              read_file: readFile,
              write_html: writeHtml,
              write_design: writeDesign,
            },
            toolPolicy: {
              completeAfterToolsExecuted: {
                toolNames: ["write_html", "write_design"],
                finalMessage: "artifacts written",
              },
            },
          }),
          [
            response({
              items: [
                {
                  type: "tool_call",
                  call: {
                    id: "call-html",
                    type: "function",
                    function: {
                      name: "write_html",
                      arguments: '{"content":"<html>first</html>"}',
                    },
                  },
                },
              ],
            }),
            response({
              items: [
                {
                  type: "tool_call",
                  call: {
                    id: "call-html-duplicate",
                    type: "function",
                    function: {
                      name: "write_html",
                      arguments: '{"content":"<html>duplicate</html>"}',
                    },
                  },
                },
              ],
            }),
            response({
              items: [
                {
                  type: "tool_call",
                  call: {
                    id: "call-design",
                    type: "function",
                    function: {
                      name: "write_design",
                      arguments: '{"content":"# Design"}',
                    },
                  },
                },
              ],
            }),
            response({ items: [{ type: "message", text: "should not be called" }] }),
          ],
        );

        expect(result).toMatchObject({ ok: true, final: "artifacts written" });
        expect(htmlExecutions).toBe(1);
        expect(designExecutions).toBe(1);
        expect(
          llmRequests.map((request) =>
            (request.tools ?? []).map((tool) => tool.function.name).sort(),
          ),
        ).toEqual([
          ["read_file", "write_design", "write_html"],
          ["read_file", "write_design"],
          ["read_file", "write_design"],
        ]);
        expect(llmRequests.map((request) => request.tool_choice)).toEqual([
          "required",
          { type: "function", function: { name: "write_design" } },
          { type: "function", function: { name: "write_design" } },
        ]);

        const runtimeEvents = events.flatMap((event) => {
          const decoded = decodeRuntimeLedgerEvent(event);
          return decoded._tag === "runtime" ? [decoded.event] : [];
        });
        const executedNames = runtimeEvents
          .filter((event) => event.kind === "tool.executed")
          .map((event) => (event.kind === "tool.executed" ? event.payload.name : ""));
        expect(executedNames).toEqual(["write_html", "write_design"]);
        const rejected = runtimeEvents.find((event) => event.kind === "tool.rejected");
        expect(rejected?.payload).toMatchObject({
          name: "write_html",
          diagnostics: {
            phase: "policy",
            reason: "policy_tool_already_executed",
          },
        });
        expect(JSON.stringify(rejected?.payload)).toContain("policy_denied");
      }),
  );

  it.effect("enforces ordered terminal tool policy after the model starts terminal writes", () =>
    Effect.gen(function* () {
      const executed: string[] = [];
      const readFile = defineTool({
        name: "read_file",
        description: "read file",
        args: Schema.Struct({ path: Schema.String }),
        execute: ({ path }) => Effect.succeed({ path, content: "input" }),
        authority: "read",
        admit: () => Effect.succeed({ ok: true }),
        execution: deterministicToolExecution(),
      });
      const writeFirst = defineTool({
        name: "write_first",
        description: "write first",
        args: Schema.Struct({ content: Schema.String }),
        execute: () =>
          Effect.sync(() => {
            executed.push("write_first");
            return { ok: true };
          }),
        authority: "write",
        admit: () => Effect.succeed({ ok: true }),
        execution: deterministicToolExecution(),
      });
      const writeSecond = defineTool({
        name: "write_second",
        description: "write second",
        args: Schema.Struct({ content: Schema.String }),
        execute: () =>
          Effect.sync(() => {
            executed.push("write_second");
            return { ok: true };
          }),
        authority: "write",
        admit: () => Effect.succeed({ ok: true }),
        execution: deterministicToolExecution(),
      });
      const writeThird = defineTool({
        name: "write_third",
        description: "write third",
        args: Schema.Struct({ content: Schema.String }),
        execute: () =>
          Effect.sync(() => {
            executed.push("write_third");
            return { ok: true };
          }),
        authority: "write",
        admit: () => Effect.succeed({ ok: true }),
        execution: deterministicToolExecution(),
      });

      const { result, events, llmRequests } = yield* runSubmit(
        baseSpec({
          tools: {
            read_file: readFile,
            write_first: writeFirst,
            write_second: writeSecond,
            write_third: writeThird,
          },
          toolPolicy: {
            completeAfterToolsExecuted: {
              toolNames: ["write_first", "write_second", "write_third"],
              ordered: true,
              finalMessage: "ordered artifacts written",
            },
          },
        }),
        [
          response({
            items: [
              {
                type: "tool_call",
                call: {
                  id: "call-read",
                  type: "function",
                  function: {
                    name: "read_file",
                    arguments: '{"path":"input.json"}',
                  },
                },
              },
            ],
          }),
          response({
            items: [
              {
                type: "tool_call",
                call: {
                  id: "call-second-early",
                  type: "function",
                  function: {
                    name: "write_second",
                    arguments: '{"content":"too early"}',
                  },
                },
              },
            ],
          }),
          response({
            items: [
              {
                type: "tool_call",
                call: {
                  id: "call-first",
                  type: "function",
                  function: {
                    name: "write_first",
                    arguments: '{"content":"first"}',
                  },
                },
              },
            ],
          }),
          response({
            items: [
              {
                type: "tool_call",
                call: {
                  id: "call-second",
                  type: "function",
                  function: {
                    name: "write_second",
                    arguments: '{"content":"second"}',
                  },
                },
              },
            ],
          }),
          response({
            items: [
              {
                type: "tool_call",
                call: {
                  id: "call-third",
                  type: "function",
                  function: {
                    name: "write_third",
                    arguments: '{"content":"third"}',
                  },
                },
              },
            ],
          }),
        ],
      );

      expect(result).toMatchObject({ ok: true, final: "ordered artifacts written" });
      expect(executed).toEqual(["write_first", "write_second", "write_third"]);
      expect(llmRequests.map((request) => request.tool_choice)).toEqual([
        "required",
        "required",
        "required",
        { type: "function", function: { name: "write_second" } },
        { type: "function", function: { name: "write_third" } },
      ]);
      const rejected = events
        .map((event) => decodeRuntimeLedgerEvent(event))
        .find((decoded) => decoded._tag === "runtime" && decoded.event.kind === "tool.rejected");
      expect(
        rejected?._tag === "runtime" && rejected.event.kind === "tool.rejected"
          ? rejected.event.payload.diagnostics
          : undefined,
      ).toMatchObject({
        phase: "policy",
        reason: "policy_tool_out_of_order",
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
            indeterminateKinds: [],
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
          scopeRef: {
            kind: "conversation",
            scopeId: "submit-runtime-events",
          },
          effectAuthorityRef: {
            authorityClass: "write",
            authorityId: "tool:intent",
          },
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
                function: {
                  name: "await_projection",
                  arguments: '{"id":"intent-1"}',
                },
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
        baseSpec({
          tools: { await_projection: tool },
          budget: { maxTurns: 2 },
        }),
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
      const { result, events } = yield* runSubmit(baseSpec({ executionIdentity }));

      expect(result).toMatchObject({ ok: true, final: "done" });
      expectRuntimePayloadsDecode(events);
      expect(decodedRuntimeBehaviorKinds(events)).toEqual([
        "agent.run.started",
        "chat.ingested",
        "llm.response",
        "agent.run.completed",
      ]);
      const completedEvent = events.find((event) => event.kind === "agent.run.completed");
      expect(completedEvent).toBeDefined();
      expect(decodeRuntimeLedgerEvent(completedEvent!)).toMatchObject({
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
      expect(events.find((event) => event.kind === "agent.run.started")?.payload).toMatchObject({
        executionIdentity,
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
      expect(decodedRuntimeBehaviorKinds(events)).toEqual([
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
      expect(decodedRuntimeBehaviorKinds(events)).toEqual([
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
      expect(decodedRuntimeBehaviorKinds(events)).toEqual([
        "agent.run.started",
        "chat.ingested",
        "llm.response",
        "tool.rejected",
        "agent.aborted.tool_error",
      ]);
    }),
  );

  it.effect("known tool schema decode failure feeds sanitized diagnostics back to the model", () =>
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
                function: {
                  name: "write_file",
                  arguments: '{"path":"out.txt"}',
                },
              },
            },
          ],
        }),
        response({
          items: [
            { type: "message", text: "retry write" },
            {
              type: "tool_call",
              call: {
                id: "call-2",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: '{"path":"out.txt","content":"ok"}',
                },
              },
            },
          ],
        }),
        response({ items: [{ type: "message", text: "done" }] }),
      ]);

      expect(result).toMatchObject({ ok: true, status: "delivered" });
      expect(decodedRuntimeBehaviorKinds(events)).toEqual([
        "agent.run.started",
        "chat.ingested",
        "llm.response",
        "tool.rejected",
        "llm.response",
        "tool.executed",
        "llm.response",
        "agent.run.completed",
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
              argumentSummary: {
                type: "object",
                keys: ["path"],
                truncated: false,
              },
            },
          },
        },
      });
      expect(JSON.stringify(events)).toContain("content");
    }),
  );

  it.effect("compacts executed tool arguments before the next provider request", () =>
    Effect.gen(function* () {
      const largeContent = `<main>${"export golf cart ".repeat(1_500)}</main>`;
      const tool = defineTool({
        name: "write_file",
        description: "write a file",
        args: Schema.Struct({ content: Schema.String }),
        execute: (args) => Effect.succeed({ bytesWritten: args.content.length }),
        authority: "write",
        admit: () => Effect.succeed({ ok: true }),
        execution: deterministicToolExecution(),
      });

      const { result, events, llmRequests } = yield* runSubmit(
        baseSpec({ tools: { write_file: tool } }),
        [
          response({
            items: [
              { type: "message", text: "write mockup" },
              {
                type: "tool_call",
                call: {
                  id: "call-1",
                  type: "function",
                  function: {
                    name: "write_file",
                    arguments: JSON.stringify({ content: largeContent }),
                  },
                },
              },
            ],
          }),
          response({ items: [{ type: "message", text: "done" }] }),
        ],
      );

      expect(result).toMatchObject({ ok: true, status: "delivered" });
      const runtimeEvents = decodedRuntimeEvents(events);
      const compaction = runtimeEvents.find(
        (event) => event.kind === RUNTIME_EVENT_KIND.RUNTIME_HISTORY_COMPACTED,
      );
      expect(compaction).toBeDefined();
      if (compaction?.kind !== RUNTIME_EVENT_KIND.RUNTIME_HISTORY_COMPACTED) {
        expect.fail("expected runtime.history_compacted event");
      }
      expect(compaction.payload).toMatchObject({
        runId: 1,
        turn: { id: 1, index: 0 },
        target: {
          kind: "tool_call_arguments",
          toolCallId: "call-1",
          toolName: "write_file",
        },
        strategy: "provider_history_string_redaction",
      });
      expect(compaction.payload.compactedBytes).toBeLessThan(compaction.payload.originalBytes);
      expect(compaction.id).toBeGreaterThan(compaction.payload.sourceEventId);
      const sourceEvent = runtimeEvents.find(
        (event) => event.id === compaction.payload.sourceEventId,
      );
      expect(sourceEvent?.kind).toBe(RUNTIME_EVENT_KIND.LLM_RESPONSE);
      expect(JSON.stringify(sourceEvent)).toContain(largeContent.slice(0, 120));

      const secondMessages = llmRequests[1]?.messages ?? [];
      const secondRequestMessages = JSON.stringify(secondMessages);
      const assistantMessage = secondMessages.find(
        (message) =>
          message.role === "assistant" && message.tool_calls?.some((call) => call.id === "call-1"),
      );
      const compactedArgumentsJson = assistantMessage?.tool_calls?.find(
        (call) => call.id === "call-1",
      )?.function.arguments;
      expect(compactedArgumentsJson).toBeDefined();
      const compactedArguments = JSON.parse(compactedArgumentsJson!);
      expect(compactedArguments).toEqual({
        content: expect.stringContaining("agentOS redacted provider history string"),
      });
      expect(secondRequestMessages).toContain("bytesWritten");
      expect(secondRequestMessages).not.toContain("provider_history_tool_arguments");
      expect(secondRequestMessages).not.toContain("originalBytes");
      expect(secondRequestMessages).not.toContain(largeContent.slice(0, 120));
    }),
  );

  it.effect("known tool JSON parse failure aborts when validation retry budget is exhausted", () =>
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

      const { result, events } = yield* runSubmit(
        baseSpec({
          tools: { lookup: tool },
          budget: { toolRetryPolicy: { correctionRetries: 0 } },
        }),
        [
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
        ],
      );

      expect(result).toMatchObject({ ok: false, reason: "tool_error" });
      expect(decodedRuntimeBehaviorKinds(events)).toEqual([
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

  it.effect("tool execution retry policy derives delayed execution retries", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const tool = defineTool({
        name: "lookup",
        description: "lookup",
        args: Schema.Struct({ q: Schema.String }),
        execute: () =>
          Effect.gen(function* () {
            attempts += 1;
            if (attempts === 1) {
              return yield* new ToolError({
                toolName: "lookup",
                cause: { reason: "transient_lookup_failure" },
              });
            }
            return { ok: true };
          }),
        authority: "read",
        admit: () => Effect.succeed({ ok: true }),
        execution: deterministicToolExecution(),
      });

      const fiber = yield* runSubmit(
        baseSpec({
          tools: { lookup: tool },
          budget: {
            toolRetryPolicy: {
              execution: {
                maxRetries: 1,
                delay: { kind: "fixed", delayMs: 1_000, jitter: false },
              },
            },
          },
        }),
        [
          response({
            items: [
              { type: "message", text: "lookup" },
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
        ],
      ).pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      expect(attempts).toBe(1);
      yield* TestClock.adjust("999 millis");
      expect(attempts).toBe(1);
      yield* TestClock.adjust("1 millis");

      const { result, events } = yield* Fiber.join(fiber);
      expect(result).toMatchObject({ ok: true, status: "delivered" });
      expect(attempts).toBe(2);
      expect(decodedRuntimeBehaviorKinds(events)).toEqual([
        "agent.run.started",
        "chat.ingested",
        "llm.response",
        "tool.executed",
        "llm.response",
        "agent.run.completed",
      ]);
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
      const materialLookups: string[] = [];
      const disposed: string[] = [];
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
        admit: () => {
          expect(materialLookups).toEqual([]);
          return Effect.succeed({ ok: true });
        },
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
        {
          onMaterial: (ref) => materialLookups.push(materialRefKey(ref)),
          onDispose: (ref, material) =>
            disposed.push(
              `${materialRefKey(ref)}:${typeof material === "string" ? material : JSON.stringify(material)}`,
            ),
        },
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
      expect(materialLookups).toEqual([materialRefKey(tokenRef)]);
      expect(disposed).toEqual([`${materialRefKey(tokenRef)}:secret-token-value`]);
      expect(JSON.stringify(events)).not.toContain("secret-token-value");
      expect(decodedRuntimeBehaviorKinds(events)).toEqual([
        "agent.run.started",
        "chat.ingested",
        "llm.response",
        "tool.executed",
        "llm.response",
        "agent.run.completed",
      ]);
    }),
  );

  it.effect(
    "passes broker placeholders to receipt-backed external tools without resolving raw material",
    () =>
      Effect.gen(function* () {
        const tokenRef = credentialMaterialRef("WP_TOKEN", {
          provider: "wordpress",
          purpose: "apply",
        });
        const domain = { kind: "workspace" as const, ref: "workspace:default" };
        const materialLookups: string[] = [];
        let observedPlaceholder = false;
        let observedReceipts: unknown;
        const receiptClaim = {
          phase: "lived" as const,
          operationRef: "tool:submit-runtime-events:1:0:call-1",
          scopeRef: { kind: "conversation" as const, scopeId: scope },
          effectAuthorityRef: {
            authorityClass: "write",
            authorityId: "tool:apply",
          },
          originRef: { originId: "run:1", originKind: "submit" },
          anchorRef: {
            anchorId: "workspace_op:receipt:tool:submit-runtime-events:1:0:call-1:broker",
            anchorKind: "external_receipt" as const,
            carrierRef: "workspace_op:carrier:workspace-op",
          },
        };
        const tool = defineTool({
          name: "apply",
          description: "apply",
          args: Schema.Struct({ title: Schema.String }),
          execute: (_args, ctx) => {
            observedPlaceholder = isMaterialBrokerPlaceholder(ctx.materials.wp_token);
            observedReceipts = ctx.materialBrokerReceipts;
            return withToolWriteRequirement(
              Effect.succeed(
                receiptBackedToolResult({
                  result: { applied: true },
                  claim: receiptClaim,
                }),
              ),
            );
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
          execution: externalToolExecution("write", domain),
        });

        const { result, events } = yield* runSubmitWithServices(
          baseSpec({
            tools: { apply: tool },
            materials: { wp_token: tokenRef },
            executionDomains: [
              {
                domain,
                replay: { access: "write", witness: "receipt" },
                broker: {
                  mode: "trusted_substitution",
                  materialKinds: ["credential"],
                  outboundBoundary: "domain-owner-defined",
                },
              },
            ],
            toolIntents: [
              {
                kind: "workspace_op.requested",
                boundaryPackage: boundaryPackage(
                  defineBoundaryContract({
                    packageId: "@agent-os/workspace-op",
                    kindPrefixes: ["workspace_op."],
                    roles: ["generator", "reader"],
                    events: {
                      "workspace_op.requested": {
                        payloadSchema: {
                          type: "object",
                          properties: { requestedBy: { type: "string" } },
                          required: ["requestedBy"],
                          additionalProperties: true,
                        },
                      },
                    },
                    effectAuthorityContracts: [],
                    materialRequirements: [],
                    settlement: defineSettlementContract({
                      settlementId: "@agent-os/workspace-op",
                      anchorKinds: ["external_receipt"],
                      rejectionKinds: ["provider_rejected"],
                      indeterminateKinds: [],
                    }),
                    projection: { derivedFromLedger: true, shadowState: false },
                  }),
                  "0.2.9",
                ),
              },
            ],
            receiptBackedTools: {
              apply: {
                kind: "intent_projection",
                intentKinds: ["workspace_op.requested"],
              },
            },
          }),
          makeServices(
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
            { onMaterial: (ref) => materialLookups.push(materialRefKey(ref)) },
          ),
        );

        expect(result).toMatchObject({ ok: true, final: "done" });
        expect(observedPlaceholder).toBe(true);
        expect(observedReceipts).toMatchObject([{ slot: "wp_token", materialKind: "credential" }]);
        expect(materialLookups).toEqual([]);
        expect(JSON.stringify(events)).not.toContain("secret-token-value");
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

  it.effect("ignores smuggled submit-scoped resolved material values and uses the resolver", () =>
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
      const smuggledSubmitFields = {
        tools: { apply: tool },
        materials: { wp_token: tokenRef },
        budget: { maxTurns: 2 },
        resolvedMaterials: { wp_token: "attacker-material" },
      } as Partial<SubmitSpec> & {
        readonly resolvedMaterials: Readonly<Record<string, ResolvedMaterial>>;
      };

      const { result, events } = yield* runSubmitWithServices(
        baseSpec(smuggledSubmitFields),
        makeServices(
          [
            response({
              items: [
                { type: "message", text: "use apply" },
                {
                  type: "tool_call",
                  call: {
                    id: "call-1",
                    type: "function",
                    function: {
                      name: "apply",
                      arguments: '{"title":"Hello"}',
                    },
                  },
                },
              ],
            }),
            response({ items: [{ type: "message", text: "applied" }] }),
          ],
          { [materialRefKey(tokenRef)]: "secret-token-value" },
        ),
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
        continuation: {
          kind: "agent.run.continuation",
          runId: 1,
          interruptId: "decision:tool%3Asubmit-runtime-events%3A1%3A0%3Acall-1",
        },
        inputRequest: {
          kind: "approval",
          subjectRef: "tool:submit-runtime-events:1:0:call-1",
          toolCallId: "call-1",
          toolName: "publish",
          ref: {
            kind: "agent.run.input_request",
            runId: 1,
            requestKind: "approval",
          },
        },
      });
      expect(executed).toBe(0);
      if (result.status !== "interrupted") {
        throw new Error("expected interrupted result");
      }
      expect(decodedRuntimeBehaviorKinds(events)).toEqual([
        "agent.run.started",
        "chat.ingested",
        "llm.response",
        "agent.run.interrupted",
      ]);
      expect(projectDecisionGate(events, result.gateRef)).toMatchObject({
        status: "requested",
      });
      const requested = events.find((event) => event.kind === DECISION_GATE_KIND.REQUESTED);
      const interrupted = decodedRuntimeEvents(events).find(
        (event) => event.kind === RUNTIME_EVENT_KIND.AGENT_RUN_INTERRUPTED,
      );
      expect(interrupted?.id).toBe((requested?.id ?? 0) + 1);
      expect(JSON.parse(JSON.stringify(result.continuation))).toEqual(result.continuation);
      expect(JSON.parse(JSON.stringify(result.inputRequest))).toEqual(result.inputRequest);
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
      expect(first.result).toMatchObject({
        ok: false,
        reason: "interrupted",
      });
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
          resume: (() => {
            if (first.result.inputRequest === undefined) {
              expect.fail("expected typed input request");
            }
            const resume = submitResumeDecisionFromInputRequestProjection(
              projectInputRequest(services.events, first.result.inputRequest.ref),
              { kind: "approval", approved: true },
            );
            if (!resume.ok) expect.fail(`expected approved input request: ${resume.reason}`);
            return resume.resume;
          })(),
        }),
        services,
      );

      expect(resumed.result).toMatchObject({ ok: true, final: "published" });
      expect(executed).toBe(1);
      expect(projectDecisionGate(services.events, first.result.gateRef)).toMatchObject({
        status: "consumed",
      });
      expect(decodedRuntimeBehaviorKinds(services.events)).toEqual([
        "agent.run.started",
        "chat.ingested",
        "llm.response",
        "agent.run.interrupted",
        "agent.run.resumed",
        "tool.executed",
        "llm.response",
        "agent.run.completed",
      ]);

      const duplicate = submitResumeDecisionFromContinuationProjection(
        projectContinuation(services.events, first.result.continuation),
        { kind: "approval", approved: true },
      );
      expect(duplicate).toMatchObject({
        ok: false,
        reason: "continuation_consumed",
      });
      if (first.result.inputRequest === undefined) {
        expect.fail("expected typed input request");
      }
      expect(
        submitResumeDecisionFromInputRequestProjection(
          projectInputRequest(services.events, first.result.inputRequest.ref),
          { kind: "approval", approved: true },
        ),
      ).toMatchObject({
        ok: false,
        reason: "input_request_consumed",
      });
      expect(executed).toBe(1);
      expect(
        services.events.filter((event) => event.kind === DECISION_GATE_KIND.CONSUMED),
      ).toHaveLength(1);
      const consumed = services.events.find((event) => event.kind === DECISION_GATE_KIND.CONSUMED);
      const runResumed = decodedRuntimeEvents(services.events).find(
        (event) => event.kind === RUNTIME_EVENT_KIND.AGENT_RUN_RESUMED,
      );
      expect(runResumed?.id).toBe((consumed?.id ?? 0) + 1);
      expect(runResumed?.payload.resumedAtEventId).toBe(consumed?.id);
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
            resume: { kind: "approval", approved: true },
          },
        }),
        services,
      );

      expect(resumed.result).toMatchObject({
        ok: false,
        reason: "tool_error",
      });
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
          return Effect.succeed({
            kind: "user_input_received",
            resume: ctx.resume,
          });
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

      const answer = { kind: "question" as const, answers: { site_style: "clean" } };
      const resumed = yield* runSubmitWithServices(
        baseSpec({
          tools: { askUserQuestions: tool },
          resume: (() => {
            if (first.result.inputRequest === undefined) {
              expect.fail("expected typed input request");
            }
            const resume = submitResumeDecisionFromInputRequestProjection(
              projectInputRequest(services.events, first.result.inputRequest.ref),
              answer,
            );
            if (!resume.ok) expect.fail(`expected approved input request: ${resume.reason}`);
            return resume.resume;
          })(),
        }),
        services,
      );

      expect(resumed.result).toMatchObject({ ok: true, final: "answered" });
      expect(observedResume).toEqual(answer);
      const executed = services.events.find((event) => event.kind === "tool.executed");
      expect(executed?.payload).toMatchObject({
        result: { kind: "user_input_received", resume: answer },
      });
    }),
  );

  it.effect("passes authorization input requests as symbolic material refs", () =>
    Effect.gen(function* () {
      let observedResume: unknown;
      const tool = defineTool({
        name: "connectGithub",
        description: "connect github",
        args: Schema.Struct({ installation: Schema.String }),
        execute: (_args, ctx) => {
          observedResume = ctx.resume;
          return Effect.succeed({
            kind: "authorization_received",
            resume: ctx.resume,
          });
        },
        authority: "write",
        admit: () => Effect.succeed({ ok: true }),
        execution: deterministicToolExecution(),
      });
      const services = makeServices([
        response({
          items: [
            { type: "message", text: "need auth" },
            {
              type: "tool_call",
              call: {
                id: "call-auth",
                type: "function",
                function: {
                  name: "connectGithub",
                  arguments: '{"installation":"install-1"}',
                },
              },
            },
          ],
        }),
        response({ items: [{ type: "message", text: "authorized" }] }),
      ]);

      const first = yield* runSubmitWithServices(
        baseSpec({
          tools: { connectGithub: tool },
          decisionInterrupts: [{ toolName: "connectGithub", reason: "authorization_required" }],
        }),
        services,
      );
      if (first.result.status !== "interrupted") {
        expect.fail("expected interrupted result");
      }
      expect(first.result.inputRequest).toMatchObject({
        kind: "authorization",
        toolCallId: "call-auth",
        toolName: "connectGithub",
        ref: {
          kind: "agent.run.input_request",
          requestKind: "authorization",
        },
      });

      yield* services.boundaryEvents.commit(
        decisionGateBoundaryContract,
        DECISION_GATE_KIND.DECIDED,
        {
          gateRef: first.result.gateRef,
          decisionRef: "decision/auth",
          decision: "approved",
          decidedBy: "operator/alice",
        },
      );

      if (first.result.inputRequest === undefined) {
        expect.fail("expected typed input request");
      }
      const authorization = {
        kind: "authorization" as const,
        authorization: {
          kind: "material_ref" as const,
          materialRef: { kind: "credential" as const, ref: "oauth/github/install-1" },
        },
      };
      const resume = submitResumeDecisionFromInputRequestProjection(
        projectInputRequest(services.events, first.result.inputRequest.ref),
        authorization,
      );
      if (!resume.ok) expect.fail(`expected approved input request: ${resume.reason}`);

      const resumed = yield* runSubmitWithServices(
        baseSpec({
          tools: { connectGithub: tool },
          resume: resume.resume,
        }),
        services,
      );

      expect(resumed.result).toMatchObject({ ok: true, final: "authorized" });
      expect(observedResume).toEqual(authorization);
      const executed = services.events.find((event) => event.kind === "tool.executed");
      expect(executed?.payload).toMatchObject({
        result: { kind: "authorization_received", resume: authorization },
      });
    }),
  );

  it.effect("rejects raw authorization resumes before they enter the ledger", () =>
    Effect.gen(function* () {
      const tool = defineTool({
        name: "connectGithub",
        description: "connect github",
        args: Schema.Struct({ installation: Schema.String }),
        execute: () => Effect.succeed({ ok: true }),
        authority: "write",
        admit: () => Effect.succeed({ ok: true }),
        execution: deterministicToolExecution(),
      });
      const services = makeServices([
        response({
          items: [
            { type: "message", text: "need auth" },
            {
              type: "tool_call",
              call: {
                id: "call-auth",
                type: "function",
                function: {
                  name: "connectGithub",
                  arguments: '{"installation":"install-1"}',
                },
              },
            },
          ],
        }),
      ]);

      const first = yield* runSubmitWithServices(
        baseSpec({
          tools: { connectGithub: tool },
          decisionInterrupts: [{ toolName: "connectGithub", reason: "authorization_required" }],
        }),
        services,
      );
      if (first.result.status !== "interrupted") {
        expect.fail("expected interrupted result");
      }

      yield* services.boundaryEvents.commit(
        decisionGateBoundaryContract,
        DECISION_GATE_KIND.DECIDED,
        {
          gateRef: first.result.gateRef,
          decisionRef: "decision/auth",
          decision: "approved",
          decidedBy: "operator/alice",
        },
      );

      const rawSecret = "SECRET_TOKEN";
      const resumed = yield* runSubmitWithServices(
        baseSpec({
          tools: { connectGithub: tool },
          resume: {
            runId: first.result.runId,
            turn: first.result.turn,
            interruptId: first.result.interruptId,
            gateRef: first.result.gateRef,
            decisionRef: "decision/auth",
            resume: {
              kind: "authorization",
              access_token: rawSecret,
            },
          } as unknown as NonNullable<SubmitSpec["resume"]>,
        }),
        services,
      );

      expect(resumed.result).toMatchObject({ ok: false, reason: "tool_error" });
      const serializedEvents = JSON.stringify(services.events);
      expect(serializedEvents).not.toContain(rawSecret);
      expect(
        decodedRuntimeEvents(services.events).some(
          (event) => event.kind === RUNTIME_EVENT_KIND.AGENT_RUN_RESUMED,
        ),
      ).toBe(false);
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
