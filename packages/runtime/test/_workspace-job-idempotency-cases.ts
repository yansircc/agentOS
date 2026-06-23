import {
  Effect,
  Fiber,
  Schema,
  TestClock,
  expect,
  it,
  makePreClaim,
  defineTool,
  externalToolExecution,
  withToolWriteRequirement,
  projectWorkspaceJobObservability,
  WORKSPACE_JOB_FACT_OWNER,
  WORKSPACE_JOB_KIND,
  settleWorkspaceJobArtifactReadbackVerified,
  settleWorkspaceJobArtifactWritten,
  settleWorkspaceJobTerminalFinalized,
  workspaceJobArtifactReadbackVerifiedPayload,
  workspaceJobArtifactWrittenPayload,
  workspaceJobRequestedPayload,
  workspaceJobTerminalFinalizedPayload,
  EXTERNAL_TOOL_EXECUTION_REQUIRES_RECEIPT_REASON,
  identity,
  response,
  baseSubmitSpec,
  makeServices,
  runJob,
  makeDataPlane,
  sha256Text,
  makeJobSpec,
  workspaceJobEvent,
  seedRequestedAndSubmitFacts,
} from "./_workspace-job-harness";

export const registerWorkspaceJobIdempotencyCases = () => {
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

      const fiber = yield* runJob(
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
      ).pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      expect(seedWrites).toBe(0);
      yield* TestClock.adjust("10 seconds");
      const projection = yield* Fiber.join(fiber);

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
      let verifyCalls = 0;

      const spec = makeJobSpec({
        dataPlane: makeDataPlane({
          readTerminalArtifact: async () => {
            readCalls += 1;
            return "finalized delivery bytes";
          },
        }),
        verifier: {
          verify: async () => {
            verifyCalls += 1;
            return {
              ok: true,
              checks: [{ name: "delivery-bytes", status: "passed" }],
            };
          },
        },
      });
      const projection = yield* runJob(spec, services);
      const replayed = yield* runJob(spec, services);

      expect(projection.status).toBe("verified");
      expect(replayed.status).toBe("verified");
      expect(readCalls).toBe(1);
      expect(verifyCalls).toBe(1);
      expect(
        services.events.filter((event) => event.kind === WORKSPACE_JOB_KIND.TERMINAL_FINALIZED),
      ).toHaveLength(1);
      expect(
        services.events.filter((event) => event.kind === WORKSPACE_JOB_KIND.VERIFIED),
      ).toHaveLength(1);
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
};
