import {
  Effect,
  Schema,
  expect,
  it,
  boundaryPackage,
  defineBoundaryContract,
  defineTool,
  externalToolExecution,
  deterministicToolExecution,
  resolveToolExecution,
  withToolReadRequirement,
  withToolWriteRequirement,
  ToolError,
  decodeRuntimeLedgerEvent,
  EXTERNAL_TOOL_EXECUTION_REQUIRES_RECEIPT_REASON,
  projectFailureDiagnostics,
  receiptBackedToolResult,
  toolReplayArtifactFromExecutedPayload,
  defineSettlementContract,
  WORKSPACE_OP_OWNER_ID,
  scope,
  baseSpec,
  response,
  makeServices,
  runSubmit,
  runSubmitWithServices,
  decodedRuntimeBehaviorKinds,
} from "./_submit-agent-harness";

export const registerSubmitAgentToolBoundaryCases = () => {
  it.effect("does not execute an external tool without a receipt-backed terminal contract", () =>
    Effect.gen(function* () {
      let liveToolExecuteCalled = false;
      const tool = defineTool({
        name: "write_file",
        description: "write file",
        args: Schema.Struct({ path: Schema.String }),
        execute: () => {
          liveToolExecuteCalled = true;
          return withToolWriteRequirement(Effect.succeed({ written: true }));
        },
        authority: "write",
        admit: () => Effect.succeed({ ok: true }),
        execution: externalToolExecution("write", {
          kind: "workspace",
          ref: "workspace:default",
        }),
      });

      const { result, events } = yield* runSubmit(
        baseSpec({
          tools: { write_file: tool },
          executionDomains: [
            {
              domain: { kind: "workspace", ref: "workspace:default" },
              replay: { access: "write", witness: "receipt" },
            },
          ],
        }),
        [
          response({
            items: [
              { type: "message", text: "write file" },
              {
                type: "tool_call",
                call: {
                  id: "call-1",
                  type: "function",
                  function: {
                    name: "write_file",
                    arguments: '{"path":"out.txt"}',
                  },
                },
              },
            ],
          }),
        ],
      );

      expect(result).toMatchObject({ ok: false, reason: "tool_error" });
      expect(liveToolExecuteCalled).toBe(false);
      expect(decodedRuntimeBehaviorKinds(events)).toEqual([
        "agent.run.started",
        "chat.ingested",
        "llm.response",
        "tool.rejected",
        "agent.aborted.tool_error",
      ]);
      expect(events.some((event) => event.kind === "tool.executed")).toBe(false);
      expect(JSON.stringify(events)).toContain(EXTERNAL_TOOL_EXECUTION_REQUIRES_RECEIPT_REASON);
      expect(projectFailureDiagnostics(events, 1)).toMatchObject({
        diagnostics: [
          {
            source: "tool",
            reason: EXTERNAL_TOOL_EXECUTION_REQUIRES_RECEIPT_REASON,
            category: "missing_execution_path",
            owner: "integrator",
            retryable: false,
            publicMessage: "This tool requires a receipt-backed execution path before it can run.",
          },
        ],
      });
    }),
  );

  it.effect("records receipt-backed external tool execution from a declared bridge result", () =>
    Effect.gen(function* () {
      let bridgeExecuteCalled = false;
      const domain = { kind: "workspace" as const, ref: "workspace:default" };
      const receiptClaim = {
        phase: "lived" as const,
        operationRef: "tool:submit-runtime-events:1:0:call-1",
        scopeRef: { kind: "conversation" as const, scopeId: scope },
        effectAuthorityRef: {
          authorityClass: "write",
          authorityId: "tool:write_file",
        },
        originRef: { originId: "run:1", originKind: "submit" },
        anchorRef: {
          anchorId: "workspace_op:receipt:tool:submit-runtime-events:1:0:call-1:7",
          anchorKind: "external_receipt" as const,
          carrierRef: "workspace_op:carrier:workspace-op",
        },
      };
      const tool = defineTool({
        name: "write_file",
        description: "write file",
        args: Schema.Struct({ path: Schema.String }),
        execute: ({ path }) => {
          bridgeExecuteCalled = true;
          return withToolWriteRequirement(
            Effect.succeed(
              receiptBackedToolResult({
                result: {
                  kind: "write_file",
                  path,
                  bytesWritten: 5,
                  resultHash: "sha256:abc",
                },
                claim: receiptClaim,
              }),
            ),
          );
        },
        authority: "write",
        admit: () => Effect.succeed({ ok: true }),
        execution: externalToolExecution("write", domain),
      });

      const { result, events } = yield* runSubmit(
        baseSpec({
          tools: { write_file: tool },
          executionDomains: [{ domain, replay: { access: "write", witness: "receipt" } }],
          toolIntents: [
            {
              kind: "workspace_op.requested",
              boundaryPackage: boundaryPackage(
                defineBoundaryContract({
                  ownerId: WORKSPACE_OP_OWNER_ID,
                  sourcePackageName: "../src/workspace-op-carrier",
                  kindPrefixes: ["workspace_op."],
                  roles: ["generator", "reader"],
                  events: {
                    "workspace_op.requested": {
                      payloadSchema: {
                        type: "object",
                        properties: { requestedBy: { type: "string" } },
                        required: ["requestedBy"],
                        additionalProperties: true,
                      },
                    },
                  },
                  effectAuthorityContracts: [],
                  materialRequirements: [],
                  settlement: defineSettlementContract({
                    settlementId: WORKSPACE_OP_OWNER_ID,
                    anchorKinds: ["external_receipt"],
                    rejectionKinds: ["provider_rejected"],
                    indeterminateKinds: [],
                  }),
                  projection: { derivedFromLedger: true, shadowState: false },
                }),
                "0.2.9",
              ),
            },
          ],
          receiptBackedTools: {
            write_file: {
              kind: "intent_projection",
              intentKinds: ["workspace_op.requested"],
            },
          },
        }),
        [
          response({
            items: [
              { type: "message", text: "write file" },
              {
                type: "tool_call",
                call: {
                  id: "call-1",
                  type: "function",
                  function: {
                    name: "write_file",
                    arguments: '{"path":"out.txt"}',
                  },
                },
              },
            ],
          }),
          response({ items: [{ type: "message", text: "done" }] }),
        ],
      );

      expect(result).toMatchObject({ ok: true, final: "done" });
      expect(bridgeExecuteCalled).toBe(true);
      const toolEvent = events
        .map((event) => decodeRuntimeLedgerEvent(event))
        .find((decoded) => decoded._tag === "runtime" && decoded.event.kind === "tool.executed");
      if (toolEvent?._tag !== "runtime" || toolEvent.event.kind !== "tool.executed") {
        expect.fail("expected tool.executed runtime event");
      }
      expect(toolEvent.event.payload).toMatchObject({
        result: { kind: "write_file", path: "out.txt", bytesWritten: 5 },
        claim: {
          phase: "lived",
          anchorRef: { anchorKind: "external_receipt" },
        },
      });
      const resolved = resolveToolExecution(toolEvent.event.payload.execution, {
        domains: [{ domain, replay: { access: "write", witness: "receipt" } }],
      });
      if (!resolved.ok) expect.fail("expected receipt execution to resolve");
      expect(
        toolReplayArtifactFromExecutedPayload(toolEvent.event.payload, resolved.resolved),
      ).toMatchObject({
        ok: true,
        artifact: {
          kind: "tool.execution.receipt",
          receipt: { anchorKind: "external_receipt" },
        },
      });
    }),
  );

  it.effect("executes external read tools when the domain law uses snapshot witness", () =>
    Effect.gen(function* () {
      let liveToolExecuteCalled = false;
      const domain = { kind: "workspace" as const, ref: "workspace:default" };
      const tool = defineTool({
        name: "read_file",
        description: "read file",
        args: Schema.Struct({ path: Schema.String }),
        execute: ({ path }) => {
          liveToolExecuteCalled = true;
          return withToolReadRequirement(Effect.succeed({ path, content: "snapshot" }));
        },
        authority: "read",
        admit: () => Effect.succeed({ ok: true }),
        execution: externalToolExecution("read", domain),
      });

      const { result, events } = yield* runSubmit(
        baseSpec({
          tools: { read_file: tool },
          executionDomains: [{ domain, replay: { access: "read", witness: "snapshot" } }],
        }),
        [
          response({
            items: [
              { type: "message", text: "read file" },
              {
                type: "tool_call",
                call: {
                  id: "call-1",
                  type: "function",
                  function: {
                    name: "read_file",
                    arguments: '{"path":"input/editor.json"}',
                  },
                },
              },
            ],
          }),
          response({ items: [{ type: "message", text: "done" }] }),
        ],
      );

      expect(result).toMatchObject({ ok: true });
      expect(liveToolExecuteCalled).toBe(true);
      expect(decodedRuntimeBehaviorKinds(events)).toContain("tool.executed");
      expect(decodedRuntimeBehaviorKinds(events)).not.toContain("tool.rejected");

      const toolEvent = events
        .map((event) => decodeRuntimeLedgerEvent(event))
        .find((decoded) => decoded._tag === "runtime" && decoded.event.kind === "tool.executed");
      if (toolEvent?._tag !== "runtime" || toolEvent.event.kind !== "tool.executed") {
        expect.fail("expected tool.executed runtime event");
      }
      const resolved = resolveToolExecution(toolEvent.event.payload.execution, {
        domains: [{ domain, replay: { access: "read", witness: "snapshot" } }],
      });
      if (!resolved.ok) {
        expect.fail("expected external read tool execution to resolve");
      }
      const artifact = toolReplayArtifactFromExecutedPayload(
        toolEvent.event.payload,
        resolved.resolved,
      );
      expect(artifact).toMatchObject({
        ok: true,
        artifact: {
          kind: "tool.result",
          execution: { kind: "external", access: "read", domain },
          result: { path: "input/editor.json", content: "snapshot" },
        },
      });
    }),
  );

  it.effect("injects the tool pre-claim when emitting a declared intent with a claim slot", () =>
    Effect.gen(function* () {
      const intentPackage = boundaryPackage(
        defineBoundaryContract({
          ownerId: "@agent-os/runtime-test.claimed-intent",
          sourcePackageName: "@agent-os/runtime-test.claimed-intent",
          kindPrefixes: ["runtime.claimed_intent."],
          roles: ["generator", "reader"],
          events: {
            "runtime.claimed_intent.requested": {
              payloadSchema: {
                type: "object",
                properties: { label: { type: "string" } },
                required: ["label"],
                additionalProperties: false,
              },
              claim: { key: "claim", phase: "pre" },
            },
          },
          effectAuthorityContracts: [],
          materialRequirements: [],
          settlement: defineSettlementContract({
            settlementId: "runtime.claimed_intent.test",
            anchorKinds: ["ledger_event"],
            rejectionKinds: ["validation_failed"],
            indeterminateKinds: [],
          }),
          projection: { derivedFromLedger: true, shadowState: false },
        }),
        "0.0.0",
      );
      const tool = defineTool({
        name: "intent",
        description: "intent",
        args: Schema.Struct({ label: Schema.String }),
        execute: (args, ctx) =>
          Effect.gen(function* () {
            if (ctx.emitIntent === undefined) {
              return yield* new ToolError({
                toolName: "intent",
                cause: { reason: "missing_emit_intent" },
              });
            }
            const emitted = yield* ctx.emitIntent("runtime.claimed_intent.requested", {
              label: args.label,
            });
            return { emittedId: emitted.id };
          }),
        authority: "write",
        admit: () => Effect.succeed({ ok: true }),
        execution: deterministicToolExecution(),
      });

      const { result, events } = yield* runSubmit(
        baseSpec({
          tools: { intent: tool },
          toolIntents: [
            {
              kind: "runtime.claimed_intent.requested",
              boundaryPackage: intentPackage,
            },
          ],
        }),
        [
          response({
            items: [
              { type: "message", text: "emit intent" },
              {
                type: "tool_call",
                call: {
                  id: "call-1",
                  type: "function",
                  function: { name: "intent", arguments: '{"label":"abc"}' },
                },
              },
            ],
          }),
          response({ items: [{ type: "message", text: "done" }] }),
        ],
      );

      expect(result).toMatchObject({ ok: true, final: "done" });
      const intentEvent = events.find((event) => event.kind === "runtime.claimed_intent.requested");
      expect(intentEvent?.factOwnerRef).toBe("@agent-os/runtime-test.claimed-intent");
      expect(intentEvent?.payload).toMatchObject({
        label: "abc",
        claim: {
          phase: "pre",
          operationRef: "tool:submit-runtime-events:1:0:call-1",
          scopeRef: {
            kind: "conversation",
            scopeId: "submit-runtime-events",
          },
          effectAuthorityRef: {
            authorityClass: "write",
            authorityId: "tool:intent",
          },
          originRef: { originKind: "submit", originId: "run:1" },
        },
      });
      expect(events.some((event) => event.kind === "tool.rejected")).toBe(false);
    }),
  );

  it.effect("lets tools wait for projections under an explicit truth identity", () =>
    Effect.gen(function* () {
      const projectionScopeRef = {
        kind: "conversation" as const,
        scopeId: "projection-owner-scope",
      };
      const projectionEffectAuthorityRef = {
        authorityClass: "tool" as const,
        authorityId: "projection-writer",
      };
      const projectionFactOwnerRef = "@agent-os/runtime-test.projection-owner" as const;
      let observedProjectionSpec:
        | {
            readonly kind: string;
            readonly scopeRef: unknown;
            readonly effectAuthorityRef: unknown;
            readonly factOwnerRef: unknown;
            readonly identity: unknown;
          }
        | undefined;
      const tool = defineTool({
        name: "await_projection",
        description: "wait projection",
        args: Schema.Struct({ id: Schema.String }),
        execute: (args, ctx) =>
          Effect.gen(function* () {
            if (ctx.awaitProjection === undefined) {
              return yield* new ToolError({
                toolName: "await_projection",
                cause: { reason: "missing_await_projection" },
              });
            }
            const row = yield* ctx.awaitProjection<{ readonly ok: boolean }>({
              kind: "runtime.test.projection",
              scopeRef: projectionScopeRef,
              effectAuthorityRef: projectionEffectAuthorityRef,
              factOwnerRef: projectionFactOwnerRef,
              identity: { id: args.id },
              maxAttempts: 1,
            });
            return { identityKey: row.identityKey, state: row.state };
          }),
        authority: "read",
        admit: () => Effect.succeed({ ok: true }),
        execution: deterministicToolExecution(),
      });
      const services = makeServices([
        response({
          items: [
            {
              type: "tool_call",
              call: {
                id: "call-1",
                type: "function",
                function: {
                  name: "await_projection",
                  arguments: '{"id":"intent-1"}',
                },
              },
            },
          ],
        }),
        response({ items: [{ type: "message", text: "projected" }] }),
      ]);
      services.projections.get = (spec) =>
        Effect.sync(() => {
          observedProjectionSpec = spec;
          return {
            kind: spec.kind,
            scope: "conversation:projection-owner-scope",
            identityKey: "intent-1",
            identity: spec.identity,
            state: { ok: true },
            version: 1,
            updatedEventId: 42,
            updatedAt: 420,
          };
        });

      const { result, events } = yield* runSubmitWithServices(
        baseSpec({
          tools: { await_projection: tool },
          budget: { maxTurns: 2 },
        }),
        services,
      );

      expect(result).toMatchObject({ ok: true, final: "projected" });
      expect(observedProjectionSpec).toMatchObject({
        kind: "runtime.test.projection",
        scopeRef: projectionScopeRef,
        effectAuthorityRef: projectionEffectAuthorityRef,
        factOwnerRef: projectionFactOwnerRef,
        identity: { id: "intent-1" },
      });
      expect(events.find((event) => event.kind === "tool.executed")?.payload).toMatchObject({
        result: { identityKey: "intent-1", state: { ok: true } },
      });
    }),
  );

  it.effect("unknown tool remains terminal-only diagnostics without a fabricated claim", () =>
    Effect.gen(function* () {
      const { result, events } = yield* runSubmit(baseSpec(), [
        response({
          items: [
            { type: "message", text: "missing" },
            {
              type: "tool_call",
              call: {
                id: "call-1",
                type: "function",
                function: { name: "missing_tool", arguments: "{}" },
              },
            },
          ],
        }),
      ]);

      expect(result).toMatchObject({ ok: false, reason: "tool_error" });
      expect(events.some((event) => event.kind === "tool.rejected")).toBe(false);
      expect(projectFailureDiagnostics(events, 1)).toMatchObject({
        diagnostics: [
          {
            source: "run",
            phase: "terminal",
            reason: "unknown_tool",
            toolName: "missing_tool",
          },
        ],
      });
    }),
  );
};
