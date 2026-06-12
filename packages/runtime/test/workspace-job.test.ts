import { Effect } from "effect";
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
import {
  WORKSPACE_JOB_FACT_OWNER,
  WORKSPACE_JOB_KIND,
  workspaceJobRequestedPayload,
} from "@agent-os/workspace-job";
import { RUNTIME_FACT_OWNER, type SubmitSpec } from "@agent-os/runtime-protocol";

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

describe("runWorkspaceJobEffect", () => {
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

  it.effect("returns the existing running run for duplicate idempotency keys", () =>
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
        status: "running",
        runId: "job-1",
        requestedEventId: 10,
        request: { idempotencyKey: "create-1" },
      });
      expect(services.llmRequests).toHaveLength(0);
      expect(seedWrites).toBe(0);
      expect(buildCalls).toBe(0);
      expect(
        services.events.filter((event) => event.kind === WORKSPACE_JOB_KIND.REQUESTED),
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
          failure: {
            phase: "submit",
            class: "provider",
            code: "workspace_job.submit.retries",
          },
        },
      });
      expect(services.events.map((event) => event.kind)).toContain(WORKSPACE_JOB_KIND.FAILED);
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
          failure: {
            phase: "finalize",
            class: "consumer_contract",
            code: "workspace_job.terminal_build_failed",
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
          failure: {
            phase: "data_plane",
            class: "provider",
            code: "workspace_job.terminal_write_failed",
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
          failure: {
            phase: "data_plane",
            class: "provider",
            code: "workspace_job.terminal_read_failed",
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
          failure: {
            phase: "collect_candidate",
            class: "consumer_contract",
            code: "workspace_job.candidate_missing",
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
          failure: {
            phase: "finalize",
            class: "consumer_contract",
            code: "workspace_job.run_id_mismatch",
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
