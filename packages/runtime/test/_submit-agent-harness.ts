import { Effect, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";
import { expect, it } from "@effect/vitest";
import {
  llmCallSnapshotFromResponse,
  LlmTransport,
  replayLlmResponseFromSnapshot,
  type LlmRequest,
  type LlmResponse,
  type LlmRoute,
  type LlmWireDescriptor,
} from "@agent-os/core/llm-protocol";
import { decodeRecordedLedgerEvent, type LedgerEvent } from "@agent-os/core/types";
import {
  compileBoundaryContract,
  defineBoundaryContract,
  type BoundaryContract,
} from "@agent-os/core/boundary-contract";
import {
  defineTool,
  externalToolExecution,
  deterministicToolExecution,
  isMaterialBrokerPlaceholder,
  resolveToolExecution,
  withToolReadRequirement,
  withToolWriteRequirement,
} from "@agent-os/core/tools";
import { ToolError } from "@agent-os/core/errors";
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
} from "@agent-os/core/runtime-protocol";
import { internalSubmitSpec, type InternalSubmitSpec } from "../src/internal-submit";
import { defineSettlementContract } from "@agent-os/core/settlement-contract";
import {
  RefResolverLive,
  type MaterialResolutionReceipt,
  type RefResolver,
} from "@agent-os/core/ref-resolver";
import { fixtureRefResolver } from "./_material-resolver-fixture";
import type { ResolvedMaterial } from "@agent-os/core/ref-resolver";
import {
  credentialMaterialRef,
  materialRefKey,
  materialRequirement,
  type MaterialRef,
} from "@agent-os/core/material-ref";
import {
  DECISION_GATE_KIND,
  decisionGateBoundaryContract,
  projectDecisionGate,
} from "../src/decision-gate";

const WORKSPACE_OP_OWNER_ID = "../src/workspace-op-carrier";
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

type TestLlmResponse = LlmResponse & {
  readonly testMaterialResolutions?: ReadonlyArray<MaterialResolutionReceipt>;
};

const response = (
  override: Partial<LlmResponse> & {
    readonly testMaterialResolutions?: ReadonlyArray<MaterialResolutionReceipt>;
  } = {},
): TestLlmResponse => ({
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
  responses: ReadonlyArray<TestLlmResponse> = [response()],
  materials: Readonly<Record<string, ResolvedMaterial>> = {},
  materialObserver: {
    readonly onMaterial?: (ref: MaterialRef) => void;
    readonly onDispose?: (ref: MaterialRef, material: ResolvedMaterial) => void;
  } = {},
  refResolver?: RefResolver,
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
    commitPrepared: (build: (builder: any) => void) =>
      Effect.sync(() => {
        const refs = new Map<string, { readonly key: string }>();
        const ids = new Map<string, number>();
        const recipes: Array<{
          readonly ref: { readonly key: string };
          readonly recipe: {
            readonly kind: string;
            readonly payload?: unknown;
            readonly buildPayload?: (context: {
              readonly id: (ref: { readonly key: string }) => number;
            }) => unknown;
            readonly scopeRef: LedgerEvent["scopeRef"];
            readonly effectAuthorityRef: LedgerEvent["effectAuthorityRef"];
            readonly ts?: number;
          };
        }> = [];
        let nextAnonymousRef = 0;
        const ref = (key: string) => {
          const existing = refs.get(key);
          if (existing !== undefined) return existing;
          const next = { key };
          refs.set(key, next);
          return next;
        };
        const id = (eventRef: { readonly key: string }) => {
          const eventId = ids.get(eventRef.key);
          if (eventId === undefined)
            throw new TypeError(`unknown ledger event ref: ${eventRef.key}`);
          return eventId;
        };
        const append = (refOrRecipe: any, maybeRecipe?: any) => {
          const eventRef =
            maybeRecipe === undefined ? ref(`event:${nextAnonymousRef++}`) : refOrRecipe;
          const recipe = maybeRecipe === undefined ? refOrRecipe : maybeRecipe;
          ids.set(eventRef.key, nextId++);
          recipes.push({ ref: eventRef, recipe });
          return eventRef;
        };
        build({ ref, id, append });
        const committed = recipes.map(({ ref: eventRef, recipe }) => {
          const eventId = id(eventRef);
          return {
            id: eventId,
            ts: recipe.ts ?? eventId * 10,
            kind: recipe.kind,
            scopeRef: recipe.scopeRef,
            effectAuthorityRef: recipe.effectAuthorityRef,
            factOwnerRef: RUNTIME_FACT_OWNER,
            payload:
              recipe.buildPayload === undefined ? recipe.payload : recipe.buildPayload({ id }),
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
      Effect.gen(function* () {
        llmRequests.push(request);
        const next = responses[callIndex] ?? response();
        callIndex += 1;
        for (const receipt of next.testMaterialResolutions ?? []) {
          yield* (request.materialResolution?.onResolved?.(receipt) ?? Effect.void).pipe(
            Effect.orDie,
          );
        }
        return next;
      }),
  };
  const quota = {
    tryGrant: () => Effect.succeed({ granted: true, consumed: 0, limit: 1 }),
  };
  const refs = RefResolverLive(
    refResolver ??
      fixtureRefResolver(
        (ref: MaterialRef) => {
          materialObserver.onMaterial?.(ref);
          const value = materials[materialRefKey(ref)];
          return value === undefined ? null : value;
        },
        ({ ref, material }) => materialObserver.onDispose?.(ref, material),
      ),
  );
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

export {
  Effect,
  Fiber,
  Schema,
  TestClock,
  expect,
  it,
  llmCallSnapshotFromResponse,
  LlmTransport,
  replayLlmResponseFromSnapshot,
  compileBoundaryContract,
  defineBoundaryContract,
  defineTool,
  externalToolExecution,
  deterministicToolExecution,
  isMaterialBrokerPlaceholder,
  resolveToolExecution,
  withToolReadRequirement,
  withToolWriteRequirement,
  ToolError,
  Admission,
  BoundaryEvents,
  Ledger,
  MaterializedProjections,
  Quota,
  submitAgentEffect,
  projectContinuation,
  submitResumeDecisionFromContinuationProjection,
  projectInputRequest,
  submitResumeDecisionFromInputRequestProjection,
  RUNTIME_FACT_OWNER,
  decodeRuntimeLedgerEvent,
  EXECUTION_IDENTITY_VERSION,
  EXTERNAL_TOOL_EXECUTION_REQUIRES_RECEIPT_REASON,
  projectFailureDiagnostics,
  replayToolFromArtifact,
  receiptBackedToolResult,
  RUNTIME_EVENT_KIND,
  toolReplayArtifactFromExecutedPayload,
  internalSubmitSpec,
  defineSettlementContract,
  RefResolverLive,
  credentialMaterialRef,
  materialRefKey,
  materialRequirement,
  DECISION_GATE_KIND,
  decisionGateBoundaryContract,
  projectDecisionGate,
  WORKSPACE_OP_OWNER_ID,
  scope,
  traceContext,
  executionIdentity,
  basePublicSpec,
  baseSpec,
  response,
  routeKind,
  testWireDescriptor,
  makeServices,
  runSubmit,
  runSubmitWithServices,
  decodedRuntimeBehaviorKinds,
  decodedRuntimeEvents,
  expectRuntimePayloadsDecode,
};
export type {
  LlmRequest,
  LlmResponse,
  LlmRoute,
  LlmWireDescriptor,
  LedgerEvent,
  BoundaryContract,
  MaterializedProjectionGetSpec,
  MaterializedProjectionRow,
  SubmitSpec,
  InternalSubmitSpec,
  ResolvedMaterial,
  MaterialRef,
};
