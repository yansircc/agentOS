import {
  Effect,
  Schema,
  expect,
  it,
  defineTool,
  deterministicToolExecution,
  projectContinuation,
  submitResumeDecisionFromContinuationProjection,
  projectInputRequest,
  submitResumeDecisionFromInputRequestProjection,
  RUNTIME_EVENT_KIND,
  DECISION_GATE_KIND,
  decisionGateBoundaryContract,
  projectDecisionGate,
  baseSpec,
  response,
  makeServices,
  runSubmit,
  runSubmitWithServices,
  decodedRuntimeBehaviorKinds,
  decodedRuntimeEvents,
  type SubmitSpec,
} from "./_submit-agent-harness";

export const registerSubmitAgentInterruptResumeCases = () => {
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
      expect(requested).toMatchObject({
        factOwnerRef: "@agent-os/decision-gate",
        scopeRef: { kind: "conversation", scopeId: "submit-runtime-events" },
        effectAuthorityRef: {
          authorityClass: "llm_route",
          authorityId: "test-route",
        },
        payload: {
          gateRef: result.gateRef,
          subjectRef: "tool:submit-runtime-events:1:0:call-1",
          claim: {
            phase: "pre",
            scopeRef: { kind: "conversation", scopeId: "submit-runtime-events" },
            effectAuthorityRef: {
              authorityClass: "llm_route",
              authorityId: "test-route",
            },
            originRef: { originKind: "submit", originId: "run:1" },
          },
        },
      });
      const requestedPayload = requested?.payload as
        | { readonly claim?: { readonly operationRef?: string } }
        | undefined;
      expect(requestedPayload?.claim?.operationRef).not.toBe(
        "tool:submit-runtime-events:1:0:call-1",
      );
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
};
