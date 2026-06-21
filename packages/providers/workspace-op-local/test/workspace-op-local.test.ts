import { describe, expect, it } from "@effect/vitest";
import { makePreClaim } from "@agent-os/kernel/effect-claim";
import {
  createWorkspaceEnv,
  type WorkspaceEnvBackend,
  type WorkspaceExecResult,
} from "@agent-os/workspace-env";
import { createWorkspaceOperationLocalProvider } from "../src";

const claim = makePreClaim({
  operationRef: "tool:run-1:call-1",
  scopeRef: { kind: "conversation", scopeId: "run-1" },
  effectAuthorityRef: { authorityClass: "workspace", authorityId: "tool:write_file" },
  originRef: { originId: "run:1", originKind: "submit" },
});

const execResult = (overrides: Partial<WorkspaceExecResult> = {}): WorkspaceExecResult => ({
  exitCode: 0,
  stdout: "ok",
  stderr: "",
  stdoutBytes: 2,
  stderrBytes: 0,
  stdoutTruncated: false,
  stderrTruncated: false,
  durationMs: 3,
  ...overrides,
});

const workspace = () => {
  const files = new Map<string, string>();
  let writes = 0;
  const backend: WorkspaceEnvBackend = {
    readFile: async (path) => files.get(path) ?? "",
    readFileBuffer: async (path) => new TextEncoder().encode(files.get(path) ?? ""),
    writeFile: async (path, content) => {
      writes += 1;
      files.set(path, content instanceof Uint8Array ? new TextDecoder().decode(content) : content);
    },
    stat: async (path) => ({
      type: files.has(path) ? "file" : "directory",
      size: files.get(path)?.length ?? 0,
    }),
    readdir: async () => [],
    exists: async (path) => files.has(path),
    mkdir: async () => undefined,
    rm: async (path) => {
      files.delete(path);
    },
    exec: async (command) =>
      execResult({
        stdout: command,
        stdoutBytes: command.length,
        stdoutTruncated: false,
      }),
  };
  const env = createWorkspaceEnv({
    cwd: "/workspace",
    domain: { kind: "workspace", ref: "workspace:test" },
    backend,
  });
  return { env, files, writes: () => writes };
};

describe("@agent-os/workspace-op-local", () => {
  it("executes write_file once per idempotency key and returns external receipt metadata", async () => {
    const state = workspace();
    const provider = createWorkspaceOperationLocalProvider({ env: state.env });
    const event = {
      id: 7,
      payload: {
        requestedBy: "@agent-os/workspace-binding",
        workspaceRef: "workspace:test",
        toolName: "write_file" as const,
        path: "out.txt",
        content: "hello",
        claim,
      },
    };

    const first = await provider.execute(event);
    const second = await provider.execute(event);

    expect(first).toEqual(second);
    expect(state.writes()).toBe(1);
    expect(state.files.get("/workspace/out.txt")).toBe("hello");
    expect(first).toMatchObject({
      ok: true,
      payload: {
        requestedEventId: 7,
        operationRef: claim.operationRef,
        idempotencyKey: claim.operationRef,
        path: "out.txt",
        bytesWritten: 5,
        claim: { phase: "lived", anchorRef: { anchorKind: "external_receipt" } },
      },
      result: {
        kind: "write_file",
        path: "out.txt",
        bytesWritten: 5,
      },
    });
    if (!first.ok) expect.fail("expected completed workspace operation");
    expect("content" in first.payload).toBe(false);
  });

  it("treats cwd-prefixed absolute paths as workspace-relative paths", async () => {
    const state = workspace();
    const provider = createWorkspaceOperationLocalProvider({ env: state.env });
    const result = await provider.execute({
      id: 8,
      payload: {
        requestedBy: "@agent-os/workspace-binding",
        workspaceRef: "workspace:test",
        toolName: "write_file",
        path: "/workspace/app.py",
        content: "print('ok')\n",
        claim: { ...claim, operationRef: "tool:run-1:call-cwd-path" },
      },
    });

    expect(state.files.get("/workspace/app.py")).toBe("print('ok')\n");
    expect(state.files.has("/workspace/workspace/app.py")).toBe(false);
    expect(result).toMatchObject({
      ok: true,
      payload: {
        path: "app.py",
      },
      result: {
        kind: "write_file",
        path: "app.py",
      },
    });
  });

  it("bounds shell output to provider result previews and hashes", async () => {
    const state = workspace();
    const provider = createWorkspaceOperationLocalProvider({ env: state.env, maxOutputBytes: 8 });
    const result = await provider.execute({
      id: 8,
      payload: {
        requestedBy: "@agent-os/workspace-binding",
        workspaceRef: "workspace:test",
        toolName: "run_shell",
        command: "printf ok",
        claim: { ...claim, operationRef: "tool:run-1:call-2" },
      },
    });

    expect(result).toMatchObject({
      ok: true,
      payload: {
        toolName: "run_shell",
        stdoutPreview: "printf o",
        stdoutBytes: 9,
        stdoutTruncated: true,
        stdoutHash: expect.any(String),
        stderrHash: expect.any(String),
        resultHash: expect.any(String),
        claim: { phase: "lived", anchorRef: { anchorKind: "external_receipt" } },
      },
    });
    if (!result.ok) expect.fail("expected completed shell operation");
    expect("stdout" in result.payload).toBe(false);
    expect("stderr" in result.payload).toBe(false);
  });

  it("treats cwd-prefixed shell cwd as workspace root", async () => {
    const state = workspace();
    const provider = createWorkspaceOperationLocalProvider({ env: state.env });
    const result = await provider.execute({
      id: 9,
      payload: {
        requestedBy: "@agent-os/workspace-binding",
        workspaceRef: "workspace:test",
        toolName: "run_shell",
        command: "pwd",
        cwd: "/workspace",
        claim: { ...claim, operationRef: "tool:run-1:call-cwd-shell" },
      },
    });

    expect(result).toMatchObject({
      ok: true,
      payload: {
        toolName: "run_shell",
        cwd: ".",
      },
    });
  });
});
