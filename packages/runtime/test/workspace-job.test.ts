import { Effect, Schema } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { makePreClaim } from "@agent-os/kernel/effect-claim";
import {
  LlmTransport,
  type LlmRequest,
  type LlmResponse,
  type LlmRoute,
  type LlmWireDescriptor,
} from "@agent-os/llm-protocol";
import type { MaterialRef } from "@agent-os/kernel/material-ref";
import { materialRefKey } from "@agent-os/kernel/material-ref";
import { RefResolutionFailed, RefResolverService } from "@agent-os/kernel/ref-resolver";
import type { ResolvedMaterial } from "@agent-os/kernel/ref-resolver";
import type { LedgerEvent } from "@agent-os/kernel/types";
import type { BoundaryContract } from "@agent-os/kernel/boundary-contract";
import {
  defineTool,
  externalToolExecution,
  withToolWriteRequirement,
} from "@agent-os/kernel/tools";
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
} from "@agent-os/workspace-job";
import {
  EXTERNAL_TOOL_EXECUTION_REQUIRES_RECEIPT_REASON,
  RUNTIME_FACT_OWNER,
  agentRunCompletedEvent,
  agentRunStartedEvent,
  type SubmitSpec,
} from "@agent-os/runtime-protocol";

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
        return committed;
      }),
    events: () => Effect.succeed(events),
    streamSnapshot: () => Effect.succeed(events),
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
    Effect.provideService(RefResolverService, services.refs),
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

describe("runWorkspaceJobEffect", () => {
  it.effect("keeps cleanup outside the shared runtime data plane", () =>
    Effect.gen(function* () {
      // @ts-expect-error cleanup is host-local; shared workspace-job runtime must not own it.
      makeDataPlane({ cleanup: async () => undefined });

      let cleanupCalled = false;
      const services = makeServices();
      yield* runJob(
        makeJobSpec({
          dataPlane: makeDataPlane({
            cleanup: async () => {
              cleanupCalled = true;
            },
          } as Partial<WorkspaceJobDataPlane> & {
            readonly cleanup: (input: { readonly runId: string }) => Promise<void>;
          }),
        }),
        services,
      );

      expect(cleanupCalled).toBe(false);
    }),
  );

  it.effect(
    "verifies finalized bytes and commits a verified projection digest for delivery bytes",
    () =>
      Effect.gen(function* () {
        const services = makeServices();
        const projection = yield* runJob(makeJobSpec(), services);

        expect(projection).toMatchObject({
          status: "verified",
          terminalArtifact: {
            artifactRef: "workspace-job://job-1/output/result.json",
            path: "/output/result.json",
            schemaId: "zeroy.agent_command_result.v1",
            bytes: 24,
          },
          checks: [{ name: "delivery-bytes", status: "passed" }],
        });
        if (projection.status !== "verified") expect.fail("expected verified projection");
        expect(projection.terminalArtifact.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
        const eventKinds = services.events.map((event) => event.kind);
        expect(eventKinds).toEqual(
          expect.arrayContaining([
            WORKSPACE_JOB_KIND.REQUESTED,
            WORKSPACE_JOB_KIND.TERMINAL_FINALIZED,
            WORKSPACE_JOB_KIND.VERIFIED,
          ]),
        );
        expect(eventKinds.indexOf(WORKSPACE_JOB_KIND.TERMINAL_FINALIZED)).toBeLessThan(
          eventKinds.indexOf(WORKSPACE_JOB_KIND.VERIFIED),
        );
      }),
  );

  it.effect("hashes and verifies readback bytes instead of builder bytes", () =>
    Effect.gen(function* () {
      const services = makeServices();
      const writes: string[] = [];
      const projection = yield* runJob(
        makeJobSpec({
          dataPlane: makeDataPlane({
            buildTerminalArtifact: async () => ({
              schemaId: "zeroy.agent_command_result.v1",
              bytes: "builder-only bytes",
            }),
            writeTerminalArtifact: async ({ runId, path, bytes }) => {
              writes.push(`${path}:${new TextDecoder().decode(bytes)}`);
              return { artifactRef: `workspace-job://${runId}${path}` };
            },
            readTerminalArtifact: async () => "readback delivery bytes",
          }),
          verifier: {
            verify: async ({ bytes }) => {
              const text = new TextDecoder().decode(bytes);
              const checks = [
                {
                  name: "readback-bytes",
                  status:
                    text === "readback delivery bytes" ? ("passed" as const) : ("failed" as const),
                },
              ];
              if (text !== "readback delivery bytes") {
                return {
                  ok: false as const,
                  reason: "readback bytes mismatch",
                  checks,
                };
              }
              return {
                ok: true as const,
                checks,
              };
            },
          },
        }),
        services,
      );
      const readbackHash = yield* Effect.promise(() => sha256Text("readback delivery bytes"));
      const builderHash = yield* Effect.promise(() => sha256Text("builder-only bytes"));

      expect(writes).toEqual(["/output/result.json:builder-only bytes"]);
      expect(projection).toMatchObject({
        status: "verified",
        terminalArtifact: {
          path: "/output/result.json",
          bytes: 23,
          sha256: `sha256:${readbackHash}`,
        },
        checks: [{ name: "readback-bytes", status: "passed" }],
      });
      if (projection.status !== "verified") expect.fail("expected verified projection");
      expect(projection.terminalArtifact.sha256).not.toBe(`sha256:${builderHash}`);
    }),
  );

  it.effect("commits verifier_rejected as a product verdict distinct from failed", () =>
    Effect.gen(function* () {
      const services = makeServices();
      const projection = yield* runJob(
        makeJobSpec({
          verifier: {
            verify: async () => ({
              ok: false,
              reason: "php lint failed",
              checks: [{ name: "php-lint", status: "failed", message: "syntax error" }],
            }),
          },
        }),
        services,
      );

      expect(projection).toMatchObject({
        status: "verifier_rejected",
        checks: [{ name: "php-lint", status: "failed" }],
      });
      expect(services.events.map((event) => event.kind)).toContain(
        WORKSPACE_JOB_KIND.VERIFIER_REJECTED,
      );
      expect(services.events.map((event) => event.kind)).not.toContain(WORKSPACE_JOB_KIND.FAILED);
    }),
  );

  it.effect("repairs verifier rejection through an agentOS-owned workspace-job attempt", () =>
    Effect.gen(function* () {
      const services = makeServices([
        response({ items: [{ type: "message", text: "bad" }] }),
        response(),
      ]);
      let builds = 0;
      const projection = yield* runJob(
        makeJobSpec({
          dataPlane: makeDataPlane({
            buildTerminalArtifact: async () => {
              builds += 1;
              return {
                schemaId: "zeroy.agent_command_result.v1",
                bytes: builds === 1 ? "bad delivery bytes" : "finalized delivery bytes",
              };
            },
          }),
          verifier: {
            verify: async ({ bytes }) => {
              const text = new TextDecoder().decode(bytes);
              return text === "finalized delivery bytes"
                ? {
                    ok: true as const,
                    checks: [{ name: "php-lint", status: "passed" as const }],
                  }
                : {
                    ok: false as const,
                    reason: "php lint failed",
                    checks: [
                      {
                        name: "php-lint",
                        status: "failed" as const,
                        message: "syntax error",
                      },
                    ],
                  };
            },
          },
          recovery: {
            maxAttempts: 2,
            shouldRepair: ({ previousAttempt }) =>
              previousAttempt.checks.some((check) => check.status === "failed"),
            buildRepairSubmitSpec: ({ attempt, previousAttempt }) => ({
              ...baseSubmitSpec(),
              intent: `repair attempt ${attempt.index}: ${previousAttempt.reason}`,
            }),
          },
        }),
        services,
      );

      expect(projection).toMatchObject({
        status: "verified",
        requestedEventId: expect.any(Number),
        request: {
          idempotencyKey: "create-1:repair:2",
          attempt: {
            index: 2,
            maxAttempts: 2,
            cause: "verifier_repair",
            repairOfRequestedEventId: expect.any(Number),
          },
        },
        checks: [{ name: "php-lint", status: "passed" }],
      });
      expect(builds).toBe(2);
      expect(services.llmRequests).toHaveLength(2);
      expect(
        services.events.filter((event) => event.kind === WORKSPACE_JOB_KIND.REQUESTED),
      ).toHaveLength(2);
      expect(
        services.events.filter((event) => event.kind === WORKSPACE_JOB_KIND.VERIFIER_REJECTED),
      ).toHaveLength(1);
      expect(services.events.map((event) => event.kind)).toContain(WORKSPACE_JOB_KIND.VERIFIED);

      const observed = projectWorkspaceJobObservability(services.events, "job-1");
      expect(observed).toMatchObject({
        status: "verified",
        request: {
          attempt: {
            index: 2,
            cause: "verifier_repair",
          },
        },
      });
    }),
  );

  it.effect("returns verifier_rejected only after repair attempts are exhausted", () =>
    Effect.gen(function* () {
      const services = makeServices([response(), response()]);
      const projection = yield* runJob(
        makeJobSpec({
          verifier: {
            verify: async () => ({
              ok: false,
              reason: "still invalid",
              checks: [{ name: "php-lint", status: "failed", message: "syntax error" }],
            }),
          },
          recovery: {
            maxAttempts: 2,
            buildRepairSubmitSpec: ({ attempt, previousAttempt }) => ({
              ...baseSubmitSpec(),
              intent: `repair attempt ${attempt.index}: ${previousAttempt.reason}`,
            }),
          },
        }),
        services,
      );

      expect(projection).toMatchObject({
        status: "verifier_rejected",
        request: {
          idempotencyKey: "create-1:repair:2",
          attempt: {
            index: 2,
            maxAttempts: 2,
            cause: "verifier_repair",
          },
        },
        checks: [{ name: "php-lint", status: "failed" }],
      });
      expect(
        services.events.filter((event) => event.kind === WORKSPACE_JOB_KIND.REQUESTED),
      ).toHaveLength(2);
      expect(
        services.events.filter((event) => event.kind === WORKSPACE_JOB_KIND.VERIFIER_REJECTED),
      ).toHaveLength(2);
      expect(services.events.map((event) => event.kind)).not.toContain(WORKSPACE_JOB_KIND.FAILED);
    }),
  );

  it.effect("settles submit spec builder failures as workspace-job request failures", () =>
    Effect.gen(function* () {
      const services = makeServices();
      const projection = yield* runJob(
        makeJobSpec({
          buildSubmitSpec: () => {
            throw new Error("cannot build submit spec");
          },
        }),
        services,
      );

      expect(projection).toMatchObject({
        status: "failed",
        failed: {
          failure: {
            phase: "request",
            reason: "submit_spec_builder_failed",
          },
        },
      });
      expect(services.events.map((event) => event.kind)).toContain(WORKSPACE_JOB_KIND.FAILED);
    }),
  );

  it.effect("settles repair decision failures as workspace-job request failures", () =>
    Effect.gen(function* () {
      const services = makeServices();
      const projection = yield* runJob(
        makeJobSpec({
          verifier: {
            verify: async () => ({
              ok: false,
              reason: "php lint failed",
              checks: [{ name: "php-lint", status: "failed", message: "syntax error" }],
            }),
          },
          recovery: {
            maxAttempts: 2,
            shouldRepair: () => {
              throw new Error("cannot decide repair");
            },
            buildRepairSubmitSpec: () => baseSubmitSpec(),
          },
        }),
        services,
      );

      expect(projection).toMatchObject({
        status: "failed",
        failed: {
          requestedEventId: expect.any(Number),
          failure: {
            phase: "request",
            reason: "repair_decision_failed",
          },
        },
      });
      expect(
        services.events.filter((event) => event.kind === WORKSPACE_JOB_KIND.VERIFIER_REJECTED),
      ).toHaveLength(1);
      expect(services.events.map((event) => event.kind)).toContain(WORKSPACE_JOB_KIND.FAILED);
    }),
  );

  it.effect("uses requested ledger facts as idempotent create truth", () =>
    Effect.gen(function* () {
      const services = makeServices();
      let buildCalls = 0;
      const spec = makeJobSpec({
        dataPlane: makeDataPlane({
          buildTerminalArtifact: async () => {
            buildCalls += 1;
            return {
              schemaId: "zeroy.agent_command_result.v1",
              bytes: "finalized delivery bytes",
            };
          },
        }),
      });

      const first = yield* runJob(spec, services);
      const second = yield* runJob(spec, services);

      expect(first.status).toBe("verified");
      expect(second.status).toBe("verified");
      expect(buildCalls).toBe(1);
      expect(
        services.events.filter((event) => event.kind === WORKSPACE_JOB_KIND.REQUESTED),
      ).toHaveLength(1);
    }),
  );

  it.effect("resumes an existing requested job instead of returning bare running projection", () =>
    Effect.gen(function* () {
      const services = makeServices();
      let seedWrites = 0;
      let buildCalls = 0;
      const existingClaim = makePreClaim({
        operationRef: "workspace_job:job-1",
        scopeRef: identity.scopeRef,
        effectAuthorityRef: identity.effectAuthorityRef,
        originRef: { originId: "create-1", originKind: "workspace_job" },
      });
      services.events.push({
        id: 10,
        ts: 10,
        kind: WORKSPACE_JOB_KIND.REQUESTED,
        scopeRef: identity.scopeRef,
        effectAuthorityRef: identity.effectAuthorityRef,
        factOwnerRef: WORKSPACE_JOB_FACT_OWNER,
        payload: workspaceJobRequestedPayload({
          runId: "job-1",
          idempotencyKey: "create-1",
          requestedBy: "zeroy",
          terminalSchemaId: "zeroy.agent_command_result.v1",
          claim: existingClaim,
        }),
      });

      const projection = yield* runJob(
        makeJobSpec({
          runId: "job-duplicate",
          idempotencyKey: "create-1",
          dataPlane: makeDataPlane({
            writeSeedFile: async () => {
              seedWrites += 1;
            },
            buildTerminalArtifact: async () => {
              buildCalls += 1;
              return {
                schemaId: "zeroy.agent_command_result.v1",
                bytes: "duplicate terminal bytes",
              };
            },
          }),
        }),
        services,
      );

      expect(projection).toMatchObject({
        status: "verified",
        runId: "job-1",
        requestedEventId: 10,
        request: { idempotencyKey: "create-1" },
      });
      expect(services.llmRequests).toHaveLength(1);
      expect(seedWrites).toBe(1);
      expect(buildCalls).toBe(1);
      expect(
        services.events.filter((event) => event.kind === WORKSPACE_JOB_KIND.REQUESTED),
      ).toHaveLength(1);
    }),
  );

  it.effect("resumes after artifact write without rebuilding or rewriting artifact", () =>
    Effect.gen(function* () {
      const services = makeServices();
      const { claim, submitRunId } = seedRequestedAndSubmitFacts(services);
      const sha256 = `sha256:${yield* Effect.promise(() => sha256Text("finalized delivery bytes"))}`;
      const artifactRef = "workspace-job://job-1/output/result.json";
      services.events.push(
        workspaceJobEvent(
          61,
          WORKSPACE_JOB_KIND.ARTIFACT_WRITTEN,
          workspaceJobArtifactWrittenPayload({
            requestedEventId: 10,
            runId: "job-1",
            idempotencyKey: "create-1",
            path: "/output/result.json",
            artifactRef,
            submitRunId,
            schemaId: "zeroy.agent_command_result.v1",
            bytes: 24,
            sha256,
            claim: settleWorkspaceJobArtifactWritten(claim, {
              runId: "job-1",
              requestedEventId: 10,
              artifactRef,
            }),
          }),
        ),
      );
      let seedWrites = 0;
      let buildCalls = 0;
      let writeCalls = 0;
      let readCalls = 0;

      const projection = yield* runJob(
        makeJobSpec({
          dataPlane: makeDataPlane({
            writeSeedFile: async () => {
              seedWrites += 1;
            },
            buildTerminalArtifact: async () => {
              buildCalls += 1;
              return { schemaId: "zeroy.agent_command_result.v1", bytes: "rebuilt" };
            },
            writeTerminalArtifact: async () => {
              writeCalls += 1;
              return { artifactRef: "workspace-job://job-1/output/rewritten.json" };
            },
            readTerminalArtifact: async () => {
              readCalls += 1;
              return "finalized delivery bytes";
            },
          }),
        }),
        services,
      );

      expect(projection.status).toBe("verified");
      expect(seedWrites).toBe(0);
      expect(buildCalls).toBe(0);
      expect(writeCalls).toBe(0);
      expect(readCalls).toBe(1);
      expect(
        services.events.filter(
          (event) => event.kind === WORKSPACE_JOB_KIND.ARTIFACT_READBACK_VERIFIED,
        ),
      ).toHaveLength(1);
      expect(
        services.events.filter((event) => event.kind === WORKSPACE_JOB_KIND.TERMINAL_FINALIZED),
      ).toHaveLength(1);
    }),
  );

  it.effect("resumes after artifact readback without duplicating readback fact", () =>
    Effect.gen(function* () {
      const services = makeServices();
      const { claim, submitRunId } = seedRequestedAndSubmitFacts(services);
      const sha256 = `sha256:${yield* Effect.promise(() => sha256Text("finalized delivery bytes"))}`;
      const artifactRef = "workspace-job://job-1/output/result.json";
      services.events.push(
        workspaceJobEvent(
          61,
          WORKSPACE_JOB_KIND.ARTIFACT_WRITTEN,
          workspaceJobArtifactWrittenPayload({
            requestedEventId: 10,
            runId: "job-1",
            idempotencyKey: "create-1",
            path: "/output/result.json",
            artifactRef,
            submitRunId,
            schemaId: "zeroy.agent_command_result.v1",
            bytes: 24,
            sha256,
            claim: settleWorkspaceJobArtifactWritten(claim, {
              runId: "job-1",
              requestedEventId: 10,
              artifactRef,
            }),
          }),
        ),
        workspaceJobEvent(
          62,
          WORKSPACE_JOB_KIND.ARTIFACT_READBACK_VERIFIED,
          workspaceJobArtifactReadbackVerifiedPayload({
            requestedEventId: 10,
            runId: "job-1",
            idempotencyKey: "create-1",
            path: "/output/result.json",
            artifactRef,
            submitRunId,
            schemaId: "zeroy.agent_command_result.v1",
            bytes: 24,
            sha256,
            claim: settleWorkspaceJobArtifactReadbackVerified(claim, {
              runId: "job-1",
              requestedEventId: 10,
              artifactRef,
              sha256,
            }),
          }),
        ),
      );
      let buildCalls = 0;
      let writeCalls = 0;
      let readCalls = 0;

      const projection = yield* runJob(
        makeJobSpec({
          dataPlane: makeDataPlane({
            buildTerminalArtifact: async () => {
              buildCalls += 1;
              return { schemaId: "zeroy.agent_command_result.v1", bytes: "rebuilt" };
            },
            writeTerminalArtifact: async () => {
              writeCalls += 1;
              return { artifactRef: "workspace-job://job-1/output/rewritten.json" };
            },
            readTerminalArtifact: async () => {
              readCalls += 1;
              return "finalized delivery bytes";
            },
          }),
        }),
        services,
      );

      expect(projection.status).toBe("verified");
      expect(buildCalls).toBe(0);
      expect(writeCalls).toBe(0);
      expect(readCalls).toBe(1);
      expect(
        services.events.filter(
          (event) => event.kind === WORKSPACE_JOB_KIND.ARTIFACT_READBACK_VERIFIED,
        ),
      ).toHaveLength(1);
      expect(
        services.events.filter((event) => event.kind === WORKSPACE_JOB_KIND.TERMINAL_FINALIZED),
      ).toHaveLength(1);
    }),
  );

  it.effect("resumes after terminal finalize without duplicating finalized fact", () =>
    Effect.gen(function* () {
      const services = makeServices();
      const { claim, submitRunId } = seedRequestedAndSubmitFacts(services);
      const sha256 = `sha256:${yield* Effect.promise(() => sha256Text("finalized delivery bytes"))}`;
      const artifactRef = "workspace-job://job-1/output/result.json";
      const terminalArtifact = {
        artifactRef,
        path: "/output/result.json",
        schemaId: "zeroy.agent_command_result.v1",
        sha256,
        bytes: 24,
      };
      services.events.push(
        workspaceJobEvent(
          61,
          WORKSPACE_JOB_KIND.ARTIFACT_WRITTEN,
          workspaceJobArtifactWrittenPayload({
            requestedEventId: 10,
            runId: "job-1",
            idempotencyKey: "create-1",
            path: terminalArtifact.path,
            artifactRef,
            submitRunId,
            schemaId: terminalArtifact.schemaId,
            bytes: terminalArtifact.bytes,
            sha256,
            claim: settleWorkspaceJobArtifactWritten(claim, {
              runId: "job-1",
              requestedEventId: 10,
              artifactRef,
            }),
          }),
        ),
        workspaceJobEvent(
          62,
          WORKSPACE_JOB_KIND.ARTIFACT_READBACK_VERIFIED,
          workspaceJobArtifactReadbackVerifiedPayload({
            requestedEventId: 10,
            runId: "job-1",
            idempotencyKey: "create-1",
            path: terminalArtifact.path,
            artifactRef,
            submitRunId,
            schemaId: terminalArtifact.schemaId,
            bytes: terminalArtifact.bytes,
            sha256,
            claim: settleWorkspaceJobArtifactReadbackVerified(claim, {
              runId: "job-1",
              requestedEventId: 10,
              artifactRef,
              sha256,
            }),
          }),
        ),
        workspaceJobEvent(
          63,
          WORKSPACE_JOB_KIND.TERMINAL_FINALIZED,
          workspaceJobTerminalFinalizedPayload({
            requestedEventId: 10,
            runId: "job-1",
            idempotencyKey: "create-1",
            terminalArtifact,
            claim: settleWorkspaceJobTerminalFinalized(claim, {
              runId: "job-1",
              requestedEventId: 10,
              artifactRef,
            }),
          }),
        ),
      );
      let readCalls = 0;

      const projection = yield* runJob(
        makeJobSpec({
          dataPlane: makeDataPlane({
            readTerminalArtifact: async () => {
              readCalls += 1;
              return "finalized delivery bytes";
            },
          }),
        }),
        services,
      );

      expect(projection.status).toBe("verified");
      expect(readCalls).toBe(1);
      expect(
        services.events.filter((event) => event.kind === WORKSPACE_JOB_KIND.TERMINAL_FINALIZED),
      ).toHaveLength(1);
      expect(
        services.events.filter((event) => event.kind === WORKSPACE_JOB_KIND.VERIFIED),
      ).toHaveLength(1);
    }),
  );

  it.effect("commits submit aborts as failed substrate failures", () =>
    Effect.gen(function* () {
      const services = makeServices();
      const projection = yield* runJob(
        makeJobSpec({
          buildSubmitSpec: () => ({
            ...baseSubmitSpec(),
            budget: { maxTurns: 0 },
          }),
        }),
        services,
      );

      expect(projection).toMatchObject({
        status: "failed",
        failed: {
          submitRunId: expect.any(Number),
          failure: {
            phase: "submit",
            code: "workspace_job.submit.retries",
            reason: "retries",
          },
        },
      });
      const observed = projectWorkspaceJobObservability(services.events, "job-1");
      expect(observed).toMatchObject({
        status: "failed",
        failureExplanation: {
          phase: "submit",
          code: "workspace_job.submit.retries",
          reason: "retries",
          category: "provider_failure",
          owner: "provider",
          publicMessage: "The upstream provider failed or timed out.",
        },
      });
      expect(JSON.stringify(observed)).not.toContain("submitRunId");
      expect(services.events.map((event) => event.kind)).toContain(WORKSPACE_JOB_KIND.FAILED);
    }),
  );

  it.effect("keeps pre-submit seed failures uncorrelated and still observable", () =>
    Effect.gen(function* () {
      const services = makeServices();
      const projection = yield* runJob(
        makeJobSpec({
          dataPlane: makeDataPlane({
            writeSeedFile: async () => {
              throw new Error("seed write failed");
            },
          }),
        }),
        services,
      );

      expect(projection).toMatchObject({
        status: "failed",
        failed: {
          failure: {
            phase: "seed",
            code: "workspace_job.seed_write_failed",
            reason: "seed_write_failed",
            retryable: true,
          },
        },
      });
      if (projection.status !== "failed") expect.fail("expected failed projection");
      expect(projection.failed.submitRunId).toBeUndefined();
      expect(services.llmRequests).toHaveLength(0);

      const observed = projectWorkspaceJobObservability(services.events, "job-1");
      expect(observed).toMatchObject({
        status: "failed",
        failureExplanation: {
          phase: "seed",
          code: "workspace_job.seed_write_failed",
          reason: "seed_write_failed",
          category: "provider_failure",
          owner: "provider",
          retryable: true,
          publicMessage: "The upstream provider failed or timed out.",
          diagnostics: [],
        },
      });
      expect(JSON.stringify(observed)).not.toContain("submitRunId");
    }),
  );

  it.effect("joins exact submit run diagnostics without leaking submitRunId to consumers", () =>
    Effect.gen(function* () {
      const services = makeServices([
        response(),
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
      ]);
      const tool = defineTool({
        name: "write_file",
        description: "write file",
        args: Schema.Struct({ path: Schema.String }),
        execute: () => withToolWriteRequirement(Effect.succeed({ written: true })),
        authority: "write",
        admit: () => Effect.succeed({ ok: true }),
        execution: externalToolExecution("write", {
          kind: "workspace",
          ref: "workspace:default",
        }),
      });

      const first = yield* runJob(makeJobSpec({ runId: "job-ok", idempotencyKey: "ok" }), services);
      expect(first.status).toBe("verified");
      const failed = yield* runJob(
        makeJobSpec({
          runId: "job-failed",
          idempotencyKey: "failed",
          buildSubmitSpec: () => ({
            ...baseSubmitSpec(),
            tools: { write_file: tool },
            executionDomains: [
              {
                domain: { kind: "workspace", ref: "workspace:default" },
                replay: { access: "write", witness: "receipt" },
              },
            ],
          }),
        }),
        services,
      );
      expect(failed).toMatchObject({
        status: "failed",
        failed: {
          submitRunId: expect.any(Number),
          failure: {
            phase: "submit",
            code: "workspace_job.submit.tool_error",
            reason: "tool_error",
          },
        },
      });
      const observed = projectWorkspaceJobObservability(services.events, "job-failed");
      expect(observed).toMatchObject({
        status: "failed",
        failureExplanation: {
          reason: "tool_error",
          category: "missing_execution_path",
          owner: "integrator",
          retryable: false,
          publicMessage: "This tool requires a receipt-backed execution path before it can run.",
          diagnostics: [
            {
              reason: EXTERNAL_TOOL_EXECUTION_REQUIRES_RECEIPT_REASON,
              toolName: "write_file",
              toolCallId: "call-1",
            },
          ],
        },
      });
      expect(JSON.stringify(observed)).not.toContain("submitRunId");
      expect(JSON.stringify(observed)).not.toContain("out.txt");
      expect(JSON.stringify(observed)).toContain("path");

      const firstObserved = projectWorkspaceJobObservability(services.events, "job-ok");
      expect(firstObserved.status).toBe("verified");
      expect(JSON.stringify(firstObserved)).not.toContain(
        EXTERNAL_TOOL_EXECUTION_REQUIRES_RECEIPT_REASON,
      );
    }),
  );

  it.effect("classifies terminal build, write, and read failures separately", () =>
    Effect.gen(function* () {
      const buildServices = makeServices();
      const buildFailed = yield* runJob(
        makeJobSpec({
          dataPlane: makeDataPlane({
            buildTerminalArtifact: async () => {
              throw new Error("terminal builder rejected payload");
            },
          }),
        }),
        buildServices,
      );
      expect(buildFailed).toMatchObject({
        status: "failed",
        failed: {
          submitRunId: expect.any(Number),
          failure: {
            phase: "finalize",
            code: "workspace_job.terminal_build_failed",
            reason: "terminal_build_failed",
          },
        },
      });

      const writeServices = makeServices();
      const writeFailed = yield* runJob(
        makeJobSpec({
          dataPlane: makeDataPlane({
            writeTerminalArtifact: async () => {
              throw new Error("workspace write failed");
            },
          }),
        }),
        writeServices,
      );
      expect(writeFailed).toMatchObject({
        status: "failed",
        failed: {
          submitRunId: expect.any(Number),
          failure: {
            phase: "data_plane",
            code: "workspace_job.terminal_write_failed",
            reason: "terminal_write_failed",
            retryable: true,
          },
        },
      });

      const readServices = makeServices();
      const readFailed = yield* runJob(
        makeJobSpec({
          dataPlane: makeDataPlane({
            readTerminalArtifact: async () => {
              throw new Error("workspace read failed");
            },
          }),
        }),
        readServices,
      );
      expect(readFailed).toMatchObject({
        status: "failed",
        failed: {
          submitRunId: expect.any(Number),
          failure: {
            phase: "data_plane",
            code: "workspace_job.terminal_read_failed",
            reason: "terminal_read_failed",
            retryable: true,
          },
        },
      });
    }),
  );

  it.effect("classifies missing candidate and runId mismatch before verification", () =>
    Effect.gen(function* () {
      const missingServices = makeServices();
      const missing = yield* runJob(
        makeJobSpec({
          dataPlane: makeDataPlane({
            buildTerminalArtifact: async ({ candidatePath }) => {
              throw new WorkspaceJobCandidateMissing({ candidatePath });
            },
          }),
        }),
        missingServices,
      );
      expect(missing).toMatchObject({
        status: "failed",
        failed: {
          submitRunId: expect.any(Number),
          failure: {
            phase: "collect_candidate",
            code: "workspace_job.candidate_missing",
            reason: "candidate_missing",
          },
        },
      });

      const mismatchServices = makeServices();
      const mismatch = yield* runJob(
        makeJobSpec({
          dataPlane: makeDataPlane({
            buildTerminalArtifact: async ({ runId }) => {
              throw new WorkspaceJobRunIdMismatch({
                expectedRunId: runId,
                actualRunId: "other-run",
              });
            },
          }),
        }),
        mismatchServices,
      );
      expect(mismatch).toMatchObject({
        status: "failed",
        failed: {
          submitRunId: expect.any(Number),
          failure: {
            phase: "finalize",
            code: "workspace_job.run_id_mismatch",
            reason: "run_id_mismatch",
          },
        },
      });
      expect(mismatchServices.events.map((event) => event.kind)).not.toContain(
        WORKSPACE_JOB_KIND.VERIFIER_REJECTED,
      );
    }),
  );

  it.effect(
    "runs a ZeroY-shaped command fixture through terminal schema and verifier declarations",
    () =>
      Effect.gen(function* () {
        const services = makeServices();
        const command = {
          schema: "zeroy.agent_command.v1",
          wordpressContextRef: "wordpress-context:home",
          patch: { target: "template-parts/hero.php" },
        };
        const projection = yield* runJob(
          makeJobSpec({
            runId: "zeroy-run-1",
            idempotencyKey: "zeroy-command-1",
            requestedBy: "zeroy",
            terminalSchemaId: "zeroy.agent_delivery.v1",
            inputRef: "zeroy-command://command-1",
            inputHash: "sha256:command",
            seedFiles: [
              {
                path: "/work/input/command.json",
                content: JSON.stringify(command),
              },
            ],
            dataPlane: makeDataPlane({
              buildTerminalArtifact: async ({ runId, terminalSchemaId }) => ({
                schemaId: terminalSchemaId,
                bytes: JSON.stringify({
                  runId,
                  patch: { files: [{ path: "template-parts/hero.php", action: "update" }] },
                }),
              }),
            }),
            verifier: {
              verify: async ({ artifact, bytes }) => {
                const payload = JSON.parse(new TextDecoder().decode(bytes)) as {
                  readonly runId: string;
                  readonly patch: { readonly files: ReadonlyArray<{ readonly path: string }> };
                };
                return {
                  ok: payload.runId === "zeroy-run-1" && payload.patch.files.length === 1,
                  reason: "zeroy verifier rejected fixture",
                  checks: [
                    {
                      name: "schema",
                      status: artifact.schemaId === "zeroy.agent_delivery.v1" ? "passed" : "failed",
                    },
                    {
                      name: "wordpress-patch",
                      status: payload.patch.files[0]?.path.endsWith(".php") ? "passed" : "failed",
                    },
                  ],
                };
              },
            },
          }),
          services,
        );

        expect(projection).toMatchObject({
          status: "verified",
          runId: "zeroy-run-1",
          terminalArtifact: {
            artifactRef: "workspace-job://zeroy-run-1/output/result.json",
            schemaId: "zeroy.agent_delivery.v1",
          },
          checks: [
            { name: "schema", status: "passed" },
            { name: "wordpress-patch", status: "passed" },
          ],
        });
      }),
  );
});
