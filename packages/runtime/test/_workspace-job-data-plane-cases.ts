import {
  Effect,
  expect,
  it,
  WorkspaceJobCandidateMissing,
  WorkspaceJobRunIdMismatch,
  projectWorkspaceJobObservability,
  WORKSPACE_JOB_KIND,
  makeServices,
  runJob,
  makeDataPlane,
  sha256Text,
  makeJobSpec,
  type WorkspaceJobDataPlane,
} from "./_workspace-job-harness";

export const registerWorkspaceJobDataPlaneCases = () => {
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
        status: "reconcile_required",
        reconcile: {
          submitRunId: expect.any(Number),
          failure: {
            phase: "data_plane",
            code: "workspace_job.terminal_write_failed",
            reason: "terminal_write_failed",
            retryable: true,
          },
        },
      });
      const observedWriteFailed = projectWorkspaceJobObservability(writeServices.events, "job-1");
      expect(observedWriteFailed).toMatchObject({
        status: "reconcile_required",
        failureExplanation: {
          phase: "data_plane",
          code: "workspace_job.terminal_write_failed",
          reason: "terminal_write_failed",
          category: "data_plane",
          owner: "integrator",
          retryable: true,
          publicMessage: "The workspace environment failed while preparing or reading files.",
        },
      });
      expect(JSON.stringify(observedWriteFailed)).not.toContain("workspace write failed");
      expect(writeServices.events.map((event) => event.kind)).not.toContain(
        WORKSPACE_JOB_KIND.FAILED,
      );
      expect(writeServices.events.map((event) => event.kind)).toContain(
        WORKSPACE_JOB_KIND.RECONCILE_REQUIRED,
      );

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
        status: "reconcile_required",
        reconcile: {
          submitRunId: expect.any(Number),
          failure: {
            phase: "data_plane",
            code: "workspace_job.terminal_read_failed",
            reason: "terminal_read_failed",
            retryable: true,
          },
        },
      });
      const observedReadFailed = projectWorkspaceJobObservability(readServices.events, "job-1");
      expect(observedReadFailed).toMatchObject({
        status: "reconcile_required",
        failureExplanation: {
          phase: "data_plane",
          code: "workspace_job.terminal_read_failed",
          reason: "terminal_read_failed",
          category: "data_plane",
          owner: "integrator",
          retryable: true,
          publicMessage: "The workspace environment failed while preparing or reading files.",
        },
      });
      expect(JSON.stringify(observedReadFailed)).not.toContain("workspace read failed");
      const rawReasonReadEvents = readServices.events.map((event) => {
        if (event.kind !== WORKSPACE_JOB_KIND.RECONCILE_REQUIRED) return event;
        const payload = event.payload as {
          readonly failure?: Record<string, unknown>;
        } & Record<string, unknown>;
        return {
          ...event,
          payload: {
            ...payload,
            failure: {
              ...payload.failure,
              reason: "AGENT_SANDBOX Durable Object namespace binding is required.",
            },
          },
        };
      });
      const observedRawReason = projectWorkspaceJobObservability(rawReasonReadEvents, "job-1");
      expect(observedRawReason).toMatchObject({
        status: "reconcile_required",
        failureExplanation: {
          phase: "data_plane",
          code: "workspace_job.terminal_read_failed",
          reason: "AGENT_SANDBOX Durable Object namespace binding is required.",
          category: "data_plane",
          owner: "integrator",
          retryable: true,
          publicMessage: "The workspace environment failed while preparing or reading files.",
        },
      });
      expect(readServices.events.map((event) => event.kind)).not.toContain(
        WORKSPACE_JOB_KIND.FAILED,
      );
      expect(readServices.events.map((event) => event.kind)).toContain(
        WORKSPACE_JOB_KIND.RECONCILE_REQUIRED,
      );
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
};
