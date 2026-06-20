import { describe, expect, it, vi } from "vite-plus/test";
import { recordedValue } from "@agent-os/kernel/recorded-value";
import type { Derived, Recordable, Recorded } from "@agent-os/kernel";
import {
  WORKSPACE_AGENT_COMMAND,
  WORKSPACE_AGENT_PROJECTION,
  createWorkspaceAgentClient,
  createWorkspaceAgentClientBridge,
  defineReconcile,
  defineWorkspaceAgentMount,
  isWorkspaceAgentCommandName,
  isWorkspaceAgentProjectionName,
  type WorkspaceAgentFilesProjectionShape,
  type WorkspaceAgentFilesProjection,
  type WorkspaceAgentReconcileContext,
} from "../src/index";

describe("@agent-os/workspace-agent", () => {
  it("splits projection reads from commands by construction", () => {
    expect(isWorkspaceAgentProjectionName(WORKSPACE_AGENT_PROJECTION.FILES)).toBe(true);
    expect(isWorkspaceAgentProjectionName(WORKSPACE_AGENT_COMMAND.READ_FILE)).toBe(false);
    expect(isWorkspaceAgentCommandName(WORKSPACE_AGENT_COMMAND.READ_FILE)).toBe(true);
  });

  it("creates a typed workspace client over the generic rpcInvoker", async () => {
    const client = createWorkspaceAgentClient({
      rpcInvoker: async (name, input) => {
        if (name === WORKSPACE_AGENT_COMMAND.READ_STATE) {
          return {
            workspaceRef: "workspace:test",
            files: [{ path: "a.txt", kind: "file" as const, size: 5 }],
          };
        }
        if (name === WORKSPACE_AGENT_COMMAND.READ_FILE) {
          const readInput = input as { readonly path: string };
          return { path: readInput.path, content: "hello" };
        }
        return { ok: true };
      },
    });

    await expect(client.invoke(WORKSPACE_AGENT_COMMAND.READ_STATE, {})).resolves.toEqual({
      workspaceRef: "workspace:test",
      files: [{ path: "a.txt", kind: "file", size: 5 }],
    });
    await expect(
      client.invoke(WORKSPACE_AGENT_COMMAND.READ_FILE, { path: "/workspace/a.txt" }),
    ).resolves.toEqual({ path: "/workspace/a.txt", content: "hello" });
    await expect(client.invoke(WORKSPACE_AGENT_COMMAND.RESET, {})).resolves.toEqual({ ok: true });
  });

  it("creates typed command helpers without owning a second client state machine", async () => {
    const calls: Array<{ readonly name: string; readonly input: unknown }> = [];
    const bridge = createWorkspaceAgentClientBridge({
      rpcInvoker: async (name, input) => {
        calls.push({ name, input });
        if (name === WORKSPACE_AGENT_COMMAND.READ_STATE) {
          return { workspaceRef: "workspace:test", files: [] };
        }
        if (name === WORKSPACE_AGENT_COMMAND.READ_FILE) {
          const readInput = input as { readonly path: string };
          return { path: readInput.path, content: "hello" };
        }
        return { ok: true };
      },
    });

    await expect(bridge.readFile({ path: "/workspace/a.txt" })).resolves.toEqual({
      path: "/workspace/a.txt",
      content: "hello",
    });
    await expect(bridge.submit({ intent: "ship", context: { prompt: "go" } })).resolves.toEqual({
      ok: true,
    });
    await expect(
      bridge.resumeInputRequest({
        ref: recordedValue({
          kind: "agent.run.input_request",
          scopeRef: { kind: "session", scopeId: "workspace-ledger" },
          runId: 1,
          turn: { id: 1, index: 0 },
          interruptId: "interrupt-1",
          interruptionEventId: 2,
          afterEventId: 2,
          gateRef: "gate-1",
          requestKind: "question",
        }),
        answer: {
          decisionRef: "decision-1",
          resume: { kind: "question", answers: { ok: true } },
        },
      }),
    ).resolves.toEqual({ ok: true });
    await expect(bridge.readState()).resolves.toEqual({
      workspaceRef: "workspace:test",
      files: [],
    });
    await expect(bridge.reset()).resolves.toEqual({ ok: true });
    await expect(bridge.destroy({ reason: "done" })).resolves.toEqual({ ok: true });
    await expect(bridge.custom({ method: "ping", input: { ok: true } })).resolves.toEqual({
      ok: true,
    });

    expect(bridge.client.getSnapshot().events).toEqual([]);
    expect(calls).toEqual([
      {
        name: WORKSPACE_AGENT_COMMAND.READ_FILE,
        input: { path: "/workspace/a.txt" },
      },
      {
        name: WORKSPACE_AGENT_COMMAND.SUBMIT,
        input: { input: { intent: "ship", context: { prompt: "go" } } },
      },
      {
        name: WORKSPACE_AGENT_COMMAND.RESUME_INPUT_REQUEST,
        input: {
          ref: {
            kind: "agent.run.input_request",
            scopeRef: { kind: "session", scopeId: "workspace-ledger" },
            runId: 1,
            turn: { id: 1, index: 0 },
            interruptId: "interrupt-1",
            interruptionEventId: 2,
            afterEventId: 2,
            gateRef: "gate-1",
            requestKind: "question",
          },
          answer: {
            decisionRef: "decision-1",
            resume: { kind: "question", answers: { ok: true } },
          },
        },
      },
      { name: WORKSPACE_AGENT_COMMAND.READ_STATE, input: {} },
      { name: WORKSPACE_AGENT_COMMAND.RESET, input: {} },
      { name: WORKSPACE_AGENT_COMMAND.DESTROY, input: { reason: "done" } },
      { name: WORKSPACE_AGENT_COMMAND.CUSTOM, input: { method: "ping", input: { ok: true } } },
    ]);
  });

  it("defines generated mount as exactly one driver plus projection sinks", () => {
    const client = createWorkspaceAgentClient();
    const mount = defineWorkspaceAgentMount({
      driver: { kind: "driver_mount", client },
      projectionSinks: [
        { kind: "projection_sink", name: WORKSPACE_AGENT_PROJECTION.RUN_EVENTS },
        { kind: "projection_sink", name: WORKSPACE_AGENT_PROJECTION.FILES },
      ],
    });

    expect(mount.driver.client).toBe(client);
    expect(mount.projectionSinks.map((sink) => sink.name)).toEqual([
      "runtime.events",
      "workspace.files",
    ]);
  });

  it("keeps reconcile policy authored while runtime owns Recorded append evidence", async () => {
    type Fact = { readonly kind: "workspace.checked"; readonly path: string };
    const appended: Fact[] = [];
    const workspaceChecked = (fact: Fact): Fact & Recordable<Fact> =>
      fact as Fact & Recordable<Fact>;
    const reconcile = defineReconcile(
      async (context: WorkspaceAgentReconcileContext<WorkspaceAgentFilesProjectionShape, Fact>) => {
        const content = await context.sandbox.readFile("/workspace/a.txt");
        if (content.length > 0) {
          await context.append(
            workspaceChecked({ kind: "workspace.checked", path: "/workspace/a.txt" }),
          );
        }
      },
    );
    const sandbox = {
      readFile: vi.fn(async () => "hello"),
    };

    await reconcile({
      sandbox: sandbox as never,
      projection: {
        schema: "agentos.workspace_agent.files.v1",
        workspaceRef: "workspace-1",
        files: [{ path: "/workspace/a.txt", kind: "file" }],
      } as unknown as WorkspaceAgentFilesProjection,
      append: async (fact) => {
        const recordedFact = { kind: fact.kind, path: fact.path } as const;
        appended.push(recordedFact);
        return recordedValue(recordedFact);
      },
    });

    expect(sandbox.readFile).toHaveBeenCalledWith("/workspace/a.txt");
    expect(appended).toEqual([{ kind: "workspace.checked", path: "/workspace/a.txt" }]);
  });

  it("keeps Derived projections and Recordable facts distinct from Recorded evidence", () => {
    type Projection = WorkspaceAgentFilesProjectionShape;
    type Fact = { readonly kind: "workspace.checked"; readonly path: string };
    const typecheck = () => {
      const derivedProjection = undefined as unknown as Projection & Derived<Projection>;
      const recordableFact = undefined as unknown as Fact & Recordable<Fact>;
      const recordedProjection = undefined as unknown as Projection & Recorded<Projection>;
      const recordedFact = undefined as unknown as Fact & Recorded<Fact>;
      const context = undefined as unknown as WorkspaceAgentReconcileContext<Projection, Fact>;

      const acceptedProjection: typeof context.projection = derivedProjection;
      void acceptedProjection;
      void context.append(recordableFact);

      // @ts-expect-error Reconcile projections are derived read models, not ledger-witnessed facts.
      const invalidProjection: typeof context.projection = recordedProjection;
      // @ts-expect-error Authored reconcile code can request Recordable facts, but cannot supply Recorded facts.
      void context.append(recordedFact);

      void invalidProjection;
    };
    void typecheck;
  });
});
