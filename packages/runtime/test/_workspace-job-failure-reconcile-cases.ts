import {
  Effect,
  Fiber,
  TestClock,
  expect,
  it,
  projectWorkspaceJobObservability,
  WORKSPACE_JOB_KIND,
  response,
  baseSubmitSpec,
  makeServices,
  runJob,
  makeDataPlane,
  makeJobSpec,
} from "./_workspace-job-harness";

export const registerWorkspaceJobFailureReconcileCases = () => {
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
        status: "reconcile_required",
        reconcile: {
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
        status: "reconcile_required",
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
      expect(services.events.map((event) => event.kind)).not.toContain(WORKSPACE_JOB_KIND.FAILED);
      expect(services.events.map((event) => event.kind)).toContain(
        WORKSPACE_JOB_KIND.RECONCILE_REQUIRED,
      );
    }),
  );

  it.effect("retries transient seed write failures before submitting the agent run", () =>
    Effect.gen(function* () {
      const services = makeServices();
      let seedWrites = 0;
      const fiber = yield* runJob(
        makeJobSpec({
          dataPlane: makeDataPlane({
            writeSeedFile: async () => {
              seedWrites += 1;
              if (seedWrites === 1) throw new Error("transient seed write failed");
            },
          }),
        }),
        services,
      ).pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      expect(seedWrites).toBe(1);
      yield* TestClock.adjust("10 seconds");
      const projection = yield* Fiber.join(fiber);

      expect(projection.status).toBe("verified");
      expect(seedWrites).toBe(2);
      expect(services.llmRequests).toHaveLength(1);
      expect(
        services.events.filter((event) => event.kind === WORKSPACE_JOB_KIND.SEED_WRITTEN),
      ).toHaveLength(1);
      expect(services.events.map((event) => event.kind)).not.toContain(WORKSPACE_JOB_KIND.FAILED);
    }),
  );

  it.effect("keeps pre-submit seed failures uncorrelated and still observable", () =>
    Effect.gen(function* () {
      const services = makeServices();
      let seedWrites = 0;
      const fiber = yield* runJob(
        makeJobSpec({
          dataPlane: makeDataPlane({
            writeSeedFile: async () => {
              seedWrites += 1;
              throw new Error("seed write failed");
            },
          }),
        }),
        services,
      ).pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      expect(seedWrites).toBe(1);
      yield* TestClock.adjust("10 seconds");
      const projection = yield* Fiber.join(fiber);

      expect(projection).toMatchObject({
        status: "reconcile_required",
        reconcile: {
          failure: {
            phase: "seed",
            code: "workspace_job.seed_write_failed",
            reason: "seed_write_failed",
            retryable: true,
          },
        },
      });
      if (projection.status !== "reconcile_required") {
        expect.fail("expected reconcile_required projection");
      }
      expect(projection.reconcile.submitRunId).toBeUndefined();
      expect(seedWrites).toBe(3);
      expect(services.llmRequests).toHaveLength(0);

      const observed = projectWorkspaceJobObservability(services.events, "job-1");
      expect(observed).toMatchObject({
        status: "reconcile_required",
        failureExplanation: {
          phase: "seed",
          code: "workspace_job.seed_write_failed",
          reason: "seed_write_failed",
          category: "data_plane",
          owner: "integrator",
          retryable: true,
          publicMessage: "The workspace environment failed while preparing or reading files.",
          diagnostics: [],
        },
      });
      expect(JSON.stringify(observed)).not.toContain("submitRunId");
      expect(services.events.map((event) => event.kind)).not.toContain(WORKSPACE_JOB_KIND.FAILED);
      expect(services.events.map((event) => event.kind)).toContain(
        WORKSPACE_JOB_KIND.RECONCILE_REQUIRED,
      );
    }),
  );
};
