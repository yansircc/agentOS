import { describe, expect, it, vi } from "vite-plus/test";
import { recordedValue } from "@agent-os/kernel/recorded-value";
import {
  WORKSPACE_AGENT_COMMAND,
  WORKSPACE_AGENT_PROJECTION,
  createWorkspaceAgentClient,
  defineReconcile,
  defineWorkspaceAgentMount,
  isWorkspaceAgentCommandName,
  isWorkspaceAgentProjectionName,
  type WorkspaceAgentFilesProjectionShape,
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
        if (name === WORKSPACE_AGENT_COMMAND.READ_FILE) {
          const readInput = input as { readonly path: string };
          return { path: readInput.path, content: "hello" };
        }
        return { ok: true };
      },
    });

    await expect(
      client.invoke(WORKSPACE_AGENT_COMMAND.READ_FILE, { path: "/workspace/a.txt" }),
    ).resolves.toEqual({ path: "/workspace/a.txt", content: "hello" });
    await expect(client.invoke(WORKSPACE_AGENT_COMMAND.RESET, {})).resolves.toEqual({ ok: true });
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

  it("keeps reconcile policy authored while typing Live sandbox and Recorded append", async () => {
    type Fact = { readonly kind: "workspace.checked"; readonly path: string };
    const appended: Fact[] = [];
    const reconcile = defineReconcile(
      async (context: WorkspaceAgentReconcileContext<WorkspaceAgentFilesProjectionShape, Fact>) => {
        const content = await context.sandbox.readFile("/workspace/a.txt");
        if (content.length > 0) {
          await context.append(
            recordedValue({ kind: "workspace.checked", path: "/workspace/a.txt" }),
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
      },
      append: async (fact) => {
        appended.push(fact);
      },
    });

    expect(sandbox.readFile).toHaveBeenCalledWith("/workspace/a.txt");
    expect(appended).toEqual([{ kind: "workspace.checked", path: "/workspace/a.txt" }]);
  });
});
