import { Effect, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";
import { expect, it } from "@effect/vitest";
import { makePreClaim } from "@agent-os/core/effect-claim";
import {
  LlmTransport,
  type LlmRequest,
  type LlmResponse,
  type LlmRoute,
  type LlmWireDescriptor,
} from "@agent-os/core/llm-protocol";
import type { MaterialRef } from "@agent-os/core/material-ref";
import { materialRefKey } from "@agent-os/core/material-ref";
import { RefResolverLive } from "@agent-os/core/ref-resolver";
import type { ResolvedMaterial } from "@agent-os/core/ref-resolver";
import { decodeRecordedLedgerEvent, type LedgerEvent } from "@agent-os/core/types";
import type { BoundaryContract } from "@agent-os/core/boundary-contract";
import { defineTool, externalToolExecution, withToolWriteRequirement } from "@agent-os/core/tools";
import { commitBoundaryEvent } from "../src/boundary-commit";
import { Admission } from "../src/admission";
import { BoundaryEvents } from "../src/boundary-events";
import { Ledger } from "../src/ledger";
import {
  MaterializedProjections,
  type MaterializedProjectionGetSpec,
  type MaterializedProjectionRow,
} from "../src/projection";
import { Quota } from "../src/quota-service";
import {
  WorkspaceJobCandidateMissing,
  WorkspaceJobRunIdMismatch,
  runWorkspaceJobEffect,
  type WorkspaceJobDataPlane,
  type RunWorkspaceJobSpec,
} from "../src/workspace-job";
import { projectWorkspaceJobObservability } from "../src/workspace-job-observability";
import {
  WORKSPACE_JOB_FACT_OWNER,
  WORKSPACE_JOB_KIND,
  settleWorkspaceJobArtifactReadbackVerified,
  settleWorkspaceJobArtifactWritten,
  settleWorkspaceJobSeedWritten,
  settleWorkspaceJobTerminalFinalized,
  workspaceJobArtifactReadbackVerifiedPayload,
  workspaceJobArtifactWrittenPayload,
  workspaceJobRequestedPayload,
  workspaceJobSeedWrittenPayload,
  workspaceJobTerminalFinalizedPayload,
} from "../src/workspace-job-carrier";
import {
  EXTERNAL_TOOL_EXECUTION_REQUIRES_RECEIPT_REASON,
  RUNTIME_FACT_OWNER,
  agentRunCompletedEvent,
  agentRunStartedEvent,
  type SubmitSpec,
} from "@agent-os/core/runtime-protocol";

const scope = "workspace-job-runtime";
const identity = {
  scopeRef: { kind: "conversation" as const, scopeId: scope },
  effectAuthorityRef: { authorityClass: "llm_route", authorityId: "test-route" },
};

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
  headers: [],
  bodySchema: {
    type: "object",
    properties: {},
    additionalProperties: true,
  },
});

const baseSubmitSpec = (): SubmitSpec => ({
  intent: "write code",
  context: { task: "generate" },
  route: {
    kind: "openai-chat-compatible",
    endpointRef: "test-endpoint",
    credentialRef: "test-credential",
    modelId: "test-model",
  },
  tools: {},
  effectAuthorityRef: identity.effectAuthorityRef,
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
          } satisfies LedgerEvent;
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
          if (eventId === undefined) throw new TypeError(`unknown ledger event ref: ${eventRef.key}`);
          return eventId;
        };
        const append = (refOrRecipe: any, maybeRecipe?: any) => {
          const eventRef = maybeRecipe === undefined ? ref(`event:${nextAnonymousRef++}`) : refOrRecipe;
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
              recipe.buildPayload === undefined
                ? recipe.payload
                : recipe.buildPayload({ id }),
          } satisfies LedgerEvent;
        });
        events.push(...committed);
        return committed.map(decodeRecordedLedgerEvent);
      }),
    events: () => Effect.succeed(events.map(decodeRecordedLedgerEvent)),
    streamSnapshot: () => Effect.succeed(events.map(decodeRecordedLedgerEvent)),
  };
  const boundaryEvents = {
    commit: (contract: BoundaryContract, event: string, payload: unknown) =>
      commitBoundaryEvent(contract, event, payload, (eventIdentity) =>
        Effect.sync(() => {
          const id = nextId++;
          const committed = {
            id,
            ts: id * 10,
            kind: event,
            scopeRef: eventIdentity.scopeRef ?? identity.scopeRef,
            effectAuthorityRef: eventIdentity.effectAuthorityRef ?? identity.effectAuthorityRef,
            factOwnerRef: eventIdentity.factOwnerRef,
            payload,
          } satisfies LedgerEvent;
          events.push(committed);
          return decodeRecordedLedgerEvent(committed);
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
  const refs = RefResolverLive({
    material: (ref: MaterialRef) => {
      const value = materials[materialRefKey(ref)];
      return value === undefined ? null : value;
    },
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
        scope: "conversation:workspace-job-runtime",
        version: 1,
        status: "current" as const,
        lastAppliedEventId: 0,
        lastRebuiltEventId: null,
        updatedAt: null,
      }),
    rebuild: () =>
      Effect.succeed({
        kind: "test.projection",
        scope: "conversation:workspace-job-runtime",
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

const runJob = (spec: RunWorkspaceJobSpec, services: ReturnType<typeof makeServices>) =>
  runWorkspaceJobEffect(spec).pipe(
    Effect.provideService(Ledger, services.ledger),
    Effect.provideService(BoundaryEvents, services.boundaryEvents),
    Effect.provideService(MaterializedProjections, services.projections),
    Effect.provideService(LlmTransport, services.llm),
    Effect.provideService(Quota, services.quota),
    Effect.provide(services.refs),
    Effect.provideService(Admission, services.admission),
  );

const makeDataPlane = (overrides: Partial<WorkspaceJobDataPlane> = {}): WorkspaceJobDataPlane => {
  let stored: Uint8Array<ArrayBufferLike> = new Uint8Array();
  return {
    writeSeedFile: async () => undefined,
    buildTerminalArtifact: async () => ({
      schemaId: "zeroy.agent_command_result.v1",
      bytes: "finalized delivery bytes",
    }),
    writeTerminalArtifact: async ({ runId, path, bytes }) => {
      stored = bytes;
      return { artifactRef: `workspace-job://${runId}${path}` };
    },
    readTerminalArtifact: async () => stored,
    ...overrides,
  };
};

const sha256Text = (value: string): Promise<string> =>
  crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)).then((buffer) =>
    Array.from(new Uint8Array(buffer))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join(""),
  );

const makeJobSpec = (overrides: Partial<RunWorkspaceJobSpec> = {}): RunWorkspaceJobSpec => ({
  scope,
  identity,
  runId: "job-1",
  idempotencyKey: "create-1",
  requestedBy: "zeroy",
  terminalSchemaId: "zeroy.agent_command_result.v1",
  candidatePath: "/output/code.fragment",
  terminalArtifactPath: "/output/result.json",
  seedFiles: [{ path: "/work/context.json", content: "{}" }],
  buildSubmitSpec: () => baseSubmitSpec(),
  dataPlane: makeDataPlane(),
  verifier: {
    verify: async ({ bytes }) => ({
      ok: true,
      checks: [
        {
          name: "delivery-bytes",
          status:
            new TextDecoder().decode(bytes) === "finalized delivery bytes" ? "passed" : "failed",
        },
      ],
    }),
  },
  ...overrides,
});

const workspaceJobEvent = (id: number, kind: string, payload: unknown): LedgerEvent => ({
  id,
  ts: id * 10,
  kind,
  scopeRef: identity.scopeRef,
  effectAuthorityRef: identity.effectAuthorityRef,
  factOwnerRef: WORKSPACE_JOB_FACT_OWNER,
  payload,
});

const runtimeEvent = (
  id: number,
  spec: ReturnType<typeof agentRunStartedEvent> | ReturnType<typeof agentRunCompletedEvent>,
): LedgerEvent => ({
  id,
  ts: id * 10,
  kind: spec.kind,
  scopeRef: spec.scopeRef,
  effectAuthorityRef: spec.effectAuthorityRef,
  factOwnerRef: RUNTIME_FACT_OWNER,
  payload: spec.payload,
});

const seedRequestedAndSubmitFacts = (
  services: ReturnType<typeof makeServices>,
  submitRunId = 50,
) => {
  const claim = makePreClaim({
    operationRef: "workspace_job:job-1",
    scopeRef: identity.scopeRef,
    effectAuthorityRef: identity.effectAuthorityRef,
    originRef: { originId: "create-1", originKind: "workspace_job" },
  });
  services.events.push(
    workspaceJobEvent(
      10,
      WORKSPACE_JOB_KIND.REQUESTED,
      workspaceJobRequestedPayload({
        runId: "job-1",
        idempotencyKey: "create-1",
        requestedBy: "zeroy",
        terminalSchemaId: "zeroy.agent_command_result.v1",
        claim,
      }),
    ),
    runtimeEvent(submitRunId, agentRunStartedEvent({ ...identity, intent: "write code" })),
    runtimeEvent(
      submitRunId + 1,
      agentRunCompletedEvent({
        ...identity,
        runId: submitRunId,
        final: "done",
        output: "done",
        outputKind: "text",
        tokensUsed: 2,
      }),
    ),
    workspaceJobEvent(
      60,
      WORKSPACE_JOB_KIND.SEED_WRITTEN,
      workspaceJobSeedWrittenPayload({
        requestedEventId: 10,
        runId: "job-1",
        idempotencyKey: "create-1",
        seedPaths: ["/work/context.json"],
        claim: settleWorkspaceJobSeedWritten(claim, { runId: "job-1", requestedEventId: 10 }),
      }),
    ),
  );
  return { claim, submitRunId };
};

export {
  Effect,
  Fiber,
  Schema,
  TestClock,
  expect,
  it,
  makePreClaim,
  LlmTransport,
  materialRefKey,
  RefResolverLive,
  decodeRecordedLedgerEvent,
  defineTool,
  externalToolExecution,
  withToolWriteRequirement,
  commitBoundaryEvent,
  Admission,
  BoundaryEvents,
  Ledger,
  MaterializedProjections,
  Quota,
  WorkspaceJobCandidateMissing,
  WorkspaceJobRunIdMismatch,
  runWorkspaceJobEffect,
  projectWorkspaceJobObservability,
  WORKSPACE_JOB_FACT_OWNER,
  WORKSPACE_JOB_KIND,
  settleWorkspaceJobArtifactReadbackVerified,
  settleWorkspaceJobArtifactWritten,
  settleWorkspaceJobSeedWritten,
  settleWorkspaceJobTerminalFinalized,
  workspaceJobArtifactReadbackVerifiedPayload,
  workspaceJobArtifactWrittenPayload,
  workspaceJobRequestedPayload,
  workspaceJobSeedWrittenPayload,
  workspaceJobTerminalFinalizedPayload,
  EXTERNAL_TOOL_EXECUTION_REQUIRES_RECEIPT_REASON,
  RUNTIME_FACT_OWNER,
  agentRunCompletedEvent,
  agentRunStartedEvent,
  scope,
  identity,
  response,
  routeKind,
  testWireDescriptor,
  baseSubmitSpec,
  makeServices,
  runJob,
  makeDataPlane,
  sha256Text,
  makeJobSpec,
  workspaceJobEvent,
  runtimeEvent,
  seedRequestedAndSubmitFacts,
};
export type {
  LlmRequest,
  LlmResponse,
  LlmRoute,
  LlmWireDescriptor,
  MaterialRef,
  ResolvedMaterial,
  LedgerEvent,
  BoundaryContract,
  MaterializedProjectionGetSpec,
  MaterializedProjectionRow,
  WorkspaceJobDataPlane,
  RunWorkspaceJobSpec,
  SubmitSpec,
};
