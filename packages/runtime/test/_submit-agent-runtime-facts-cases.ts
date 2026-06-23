import {
  Effect,
  Schema,
  expect,
  it,
  defineTool,
  deterministicToolExecution,
  decodeRuntimeLedgerEvent,
  traceContext,
  executionIdentity,
  baseSpec,
  response,
  runSubmit,
  decodedRuntimeBehaviorKinds,
  expectRuntimePayloadsDecode,
} from "./_submit-agent-harness";

export const registerSubmitAgentRuntimeFactsCases = () => {
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
};
