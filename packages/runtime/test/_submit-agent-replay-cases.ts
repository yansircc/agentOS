import {
  Effect,
  Schema,
  expect,
  it,
  llmCallSnapshotFromResponse,
  replayLlmResponseFromSnapshot,
  defineTool,
  deterministicToolExecution,
  resolveToolExecution,
  decodeRuntimeLedgerEvent,
  replayToolFromArtifact,
  toolReplayArtifactFromExecutedPayload,
  baseSpec,
  response,
  testWireDescriptor,
  runSubmit,
  type LlmRoute,
} from "./_submit-agent-harness";

export const registerSubmitAgentReplayCases = () => {
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
};
