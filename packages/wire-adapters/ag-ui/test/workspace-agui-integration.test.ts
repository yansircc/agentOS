import { Effect } from "effect";
import { describe, expect, it, vi } from "@effect/vitest";
import { makePreClaim } from "@agent-os/kernel/effect-claim";
import type { LedgerEvent } from "@agent-os/kernel/types";
import type { ToolProjectionRow, ToolProjectionWaitSpec } from "@agent-os/kernel/tools";
import { settleToolExecuted, settleToolExecutionRejected } from "@agent-os/runtime";
import {
  makeCloudflareWorkspaceEnv,
  type CloudflareWorkspaceEnvClient,
} from "@agent-os/workspace-env-cloudflare";
import { bindWorkspaceToolsForRuntime } from "@agent-os/workspace-binding";
import { createWorkspaceOperationLocalProvider } from "@agent-os/workspace-op-local";
import {
  WORKSPACE_OP_FACT_OWNER,
  WORKSPACE_OP_KIND,
  WORKSPACE_OP_PROJECTION_KIND,
  projectWorkspaceOperation,
} from "@agent-os/workspace-op";
import {
  EXTERNAL_TOOL_EXECUTION_REQUIRES_RECEIPT_REASON,
  agentRunAbortedEvent,
  agentRunCompletedEvent,
  agentRunStartedEvent,
  chatIngestedEvent,
  llmResponseEvent,
  projectFailureDiagnostics,
  receiptBackedToolResultFromUnknown,
  toolExecutedEvent,
  toolRejectedEvent,
  type RuntimeEventCommitSpec,
} from "@agent-os/runtime-protocol";
import {
  agUiRunAgentInputToSubmitSpec,
  projectAgUiFrames,
  projectLedgerEventsToAgUiFrames,
  verifyAgUiFrameSafety,
  type AgUiRunAgentInput,
} from "../src/index";

const scope = "workspace-agui-fixture";

const runtimeIdentity = {
  scopeRef: { kind: "conversation" as const, scopeId: scope },
  effectAuthorityRef: { authorityClass: "llm_route", authorityId: "workspace-agui" },
};

const commit = (id: number, spec: RuntimeEventCommitSpec): LedgerEvent => ({
  id,
  ts: id * 10,
  kind: spec.kind,
  scopeRef: spec.scopeRef,
  effectAuthorityRef: spec.effectAuthorityRef,
  factOwnerRef: "@agent-os/test",
  payload: spec.payload,
});

const workspaceCommit = (id: number, kind: string, payload: unknown): LedgerEvent => ({
  id,
  ts: id * 10,
  kind,
  scopeRef: runtimeIdentity.scopeRef,
  effectAuthorityRef: runtimeIdentity.effectAuthorityRef,
  factOwnerRef: WORKSPACE_OP_FACT_OWNER,
  payload,
});

describe("Cloudflare workspace tools to AG-UI integration fixture", () => {
  it.effect(
    "uses standard workspace binding, receipt-backed writes, diagnostics, and safe AG-UI egress",
    () =>
      Effect.gen(function* () {
        const files = new Map<string, string>([
          ["/workspace/project/src/input.txt", "READ_SECRET\n"],
        ]);
        const writeFile = vi.fn<NonNullable<CloudflareWorkspaceEnvClient["writeFile"]>>(
          async (path, content) => {
            if (typeof content !== "string") throw new TypeError("fixture expects text content");
            files.set(path, content);
          },
        );
        const mkdir = vi.fn<NonNullable<CloudflareWorkspaceEnvClient["mkdir"]>>(
          async () => undefined,
        );
        const client: CloudflareWorkspaceEnvClient = {
          id: "cf-fixture",
          exec: async () => ({ exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 }),
          readFile: async (path) => ({ content: files.get(path) ?? "" }),
          writeFile,
          mkdir,
          listFiles: async () => ({ files: ["src/input.txt"] }),
        };
        const env = makeCloudflareWorkspaceEnv({
          client,
          cwd: "/workspace/project",
          workspaceRef: "cf-fixture",
        });
        const bindings = bindWorkspaceToolsForRuntime({
          env,
          authority: "workspace.fixture",
          admit: () => Effect.succeed({ ok: true }),
          exposure: ["read", "mutation"],
          mutationPolicy: "receipt-backed",
        });
        const input: AgUiRunAgentInput = {
          threadId: "thread-workspace",
          runId: "client-run-workspace",
          messages: [{ id: "m1", role: "user", content: "read input then write output" }],
          tools: [{ name: "client-local-tool", description: "not source truth" }],
          forwardedProps: { allowedTrace: "trace-1", droppedSecret: "UI_SECRET" },
        };

        const submit = agUiRunAgentInputToSubmitSpec(input, {
          route: {
            kind: "openai-chat-compatible",
            endpointRef: "endpoint:test",
            credentialRef: "credential:test",
            modelId: "model",
          },
          tools: bindings.tools ?? {},
          executionDomains: bindings.executionDomains,
          materials: bindings.materials,
          resolvedMaterials: bindings.resolvedMaterials,
          toolContext: bindings.toolContext,
          toolIntents: bindings.toolIntents,
          receiptBackedTools: bindings.receiptBackedTools,
          effectAuthorityRef: runtimeIdentity.effectAuthorityRef,
          forwardedPropAllowlist: ["allowedTrace"],
        });

        expect(Object.keys(submit.tools).sort()).toEqual([
          "delete_path",
          "edit_file",
          "glob_files",
          "grep_files",
          "list_files",
          "read_file",
          "write_file",
        ]);
        expect(submit.executionDomains).toEqual([
          { domain: env.domain, replay: { access: "read", witness: "snapshot" } },
          { domain: env.domain, replay: { access: "write", witness: "receipt" } },
        ]);
        expect(submit.resolvedMaterials?.workspace).toBe(env);
        expect(submit.toolIntents).toEqual([
          expect.objectContaining({ kind: WORKSPACE_OP_KIND.REQUESTED }),
        ]);
        expect(submit.receiptBackedTools?.write_file).toEqual({
          kind: "intent_projection",
          intentKinds: [WORKSPACE_OP_KIND.REQUESTED],
        });
        expect(JSON.stringify(submit.context)).toContain("allowedTrace");
        expect(JSON.stringify(submit.context)).not.toContain("UI_SECRET");
        expect(JSON.stringify(submit.tools)).not.toContain("client-local-tool");

        const readTool = submit.tools.read_file;
        const writeTool = submit.tools.write_file;
        if (readTool === undefined || writeTool === undefined) {
          expect.fail("workspace binding did not expose expected fixture tools");
        }

        const readResult = yield* readTool.execute({ path: "/src/input.txt" }, { materials: {} });
        expect(readResult).toMatchObject({
          path: "src/input.txt",
          content: "READ_SECRET\n",
          truncated: false,
        });

        const writeClaim = makePreClaim({
          operationRef: "tool:workspace-agui:1:0:write-call",
          scopeRef: runtimeIdentity.scopeRef,
          effectAuthorityRef: writeTool.contract.effectAuthorityRef,
          originRef: { originId: "run:1", originKind: "submit" },
        });
        const provider = createWorkspaceOperationLocalProvider({ env });
        const workspaceEvents: LedgerEvent[] = [];
        const writeResult = yield* writeTool.execute(
          { path: "/src/output.txt", content: "WRITE_SECRET" },
          {
            materials: {},
            emitIntent: (kind, payload) =>
              Effect.tryPromise({
                try: async () => {
                  expect(kind).toBe(WORKSPACE_OP_KIND.REQUESTED);
                  const requested = workspaceCommit(7, kind, {
                    ...(payload as object),
                    claim: writeClaim,
                  });
                  workspaceEvents.push(requested);
                  const providerResult = await provider.execute({
                    id: requested.id,
                    payload: requested.payload as never,
                  });
                  workspaceEvents.push(
                    workspaceCommit(
                      8,
                      providerResult.ok ? WORKSPACE_OP_KIND.COMPLETED : WORKSPACE_OP_KIND.REJECTED,
                      providerResult.payload,
                    ),
                  );
                  return { id: requested.id };
                },
                catch: (cause) => cause as never,
              }),
            awaitProjection: <State>(spec: ToolProjectionWaitSpec<State>) =>
              Effect.sync((): ToolProjectionRow<State> => {
                expect(spec.kind).toBe(WORKSPACE_OP_PROJECTION_KIND);
                expect(spec.factOwnerRef).toBe(WORKSPACE_OP_FACT_OWNER);
                const state = projectWorkspaceOperation(workspaceEvents, 7) as State;
                return {
                  kind: WORKSPACE_OP_PROJECTION_KIND,
                  projectionKind: WORKSPACE_OP_PROJECTION_KIND,
                  identityKey: "7",
                  updatedEventId: 8,
                  state,
                };
              }),
          },
        );
        const receiptResult = receiptBackedToolResultFromUnknown(writeResult);
        expect(receiptResult).toMatchObject({
          result: { kind: "write_file", path: "src/output.txt" },
          receipt: { anchorKind: "external_receipt" },
        });
        expect(files.get("/workspace/project/src/output.txt")).toBe("WRITE_SECRET");
        expect(writeFile).toHaveBeenCalledWith(
          "/workspace/project/src/output.txt",
          "WRITE_SECRET",
          {
            encoding: "utf-8",
          },
        );

        const readClaim = makePreClaim({
          operationRef: "tool:workspace-agui:1:0:read-call",
          scopeRef: runtimeIdentity.scopeRef,
          effectAuthorityRef: readTool.contract.effectAuthorityRef,
          originRef: { originId: "run:1", originKind: "submit" },
        });
        const runtimeEvents = [
          commit(1, agentRunStartedEvent({ ...runtimeIdentity, intent: submit.intent })),
          commit(
            2,
            chatIngestedEvent({
              ...runtimeIdentity,
              runId: 1,
              intent: submit.intent,
              context: submit.context,
            }),
          ),
          commit(
            3,
            llmResponseEvent({
              ...runtimeIdentity,
              turn: { id: 1, index: 0 },
              items: [
                {
                  type: "tool_call",
                  call: {
                    id: "read-call",
                    type: "function",
                    function: { name: "read_file", arguments: '{"path":"/src/input.txt"}' },
                  },
                },
                {
                  type: "tool_call",
                  call: {
                    id: "write-call",
                    type: "function",
                    function: {
                      name: "write_file",
                      arguments: '{"path":"/src/output.txt","content":"WRITE_SECRET"}',
                    },
                    metadata: { providerUrl: "https://provider.invalid/secret" },
                  },
                },
              ],
              usage: { promptTokens: 10, completionTokens: 12, totalTokens: 22 },
            }),
          ),
          commit(
            4,
            toolExecutedEvent({
              ...runtimeIdentity,
              runId: 1,
              toolCallId: "read-call",
              name: "read_file",
              args: { path: "/src/input.txt" },
              execution: readTool.execution,
              result: readResult,
              claim: settleToolExecuted(readClaim, readTool.contract),
            }),
          ),
          commit(
            5,
            toolExecutedEvent({
              ...runtimeIdentity,
              runId: 1,
              toolCallId: "write-call",
              name: "write_file",
              args: { path: "/src/output.txt", content: "WRITE_SECRET" },
              execution: writeTool.execution,
              result: receiptResult?.result,
              claim: receiptResult!.claim,
            }),
          ),
          commit(
            6,
            agentRunCompletedEvent({
              ...runtimeIdentity,
              runId: 1,
              final: "done",
              output: "done",
              outputKind: "text",
              tokensUsed: 22,
            }),
          ),
        ];
        const frames = projectLedgerEventsToAgUiFrames([...runtimeEvents, ...workspaceEvents], {
          threadId: input.threadId,
          projectSafeExtensionEvent: (event) =>
            event.kind.startsWith("workspace_op.")
              ? [
                  {
                    type: "CUSTOM",
                    timestamp: event.ts,
                    name: event.kind,
                    value: { id: event.id, kind: event.kind },
                  },
                ]
              : [],
        });

        expect(projectAgUiFrames(frames)).toMatchObject({
          runId: "1",
          threadId: "thread-workspace",
          status: "completed",
          toolCalls: expect.arrayContaining([
            expect.objectContaining({ toolCallId: "read-call", name: "read_file" }),
            expect.objectContaining({ toolCallId: "write-call", name: "write_file" }),
          ]),
        });
        expect(
          verifyAgUiFrameSafety(frames, {
            forbiddenLiterals: ["READ_SECRET", "WRITE_SECRET", "UI_SECRET", "external_receipt"],
            forbiddenPatterns: [/provider\.invalid/u, /workspace_op:receipt/u],
          }),
        ).toEqual([]);

        const rejectedClaim = makePreClaim({
          operationRef: "tool:workspace-agui:1:0:missing-receipt",
          scopeRef: runtimeIdentity.scopeRef,
          effectAuthorityRef: writeTool.contract.effectAuthorityRef,
          originRef: { originId: "run:1", originKind: "submit" },
        });
        const diagnostics = projectFailureDiagnostics(
          [
            commit(
              20,
              toolRejectedEvent({
                ...runtimeIdentity,
                runId: 2,
                toolCallId: "missing-receipt",
                name: "write_file",
                args: { type: "object", keys: ["content", "path"], truncated: false },
                execution: writeTool.execution,
                claim: settleToolExecutionRejected(
                  rejectedClaim,
                  EXTERNAL_TOOL_EXECUTION_REQUIRES_RECEIPT_REASON,
                ),
              }),
            ),
            commit(
              21,
              agentRunAbortedEvent({
                ...runtimeIdentity,
                kind: "agent.aborted.tool_error",
                runId: 2,
                tokensUsed: 0,
                payload: {
                  toolName: "write_file",
                  cause: EXTERNAL_TOOL_EXECUTION_REQUIRES_RECEIPT_REASON,
                },
              }),
            ),
          ],
          2,
        );
        expect(diagnostics?.diagnostics[0]).toMatchObject({
          category: "missing_execution_path",
          owner: "integrator",
          retryable: false,
          publicMessage: "This tool requires a receipt-backed execution path before it can run.",
        });
      }),
  );
});
