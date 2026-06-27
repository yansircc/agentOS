import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { bindWorkspaceToolsForRuntime, createWorkspaceEnv } from "../src";
import {
  cleanupWorkspaceSessionLease,
  defineWorkspaceSessionLease,
  readWorkspaceSessionTerminalArtifact,
  workspaceSessionToolOptions,
  workspaceSessionToolPolicy,
  WorkspaceSessionLifecycleError,
} from "../src/workspace-session";

const env = createWorkspaceEnv({
  domain: { kind: "workspace", ref: "workspace:session" },
  cwd: "/tmp/agentos-workspace-session-test",
  backend: {
    readFile: async () => "",
    readFileBuffer: async () => new Uint8Array(),
    writeFile: async () => {},
    stat: async () => ({ type: "file" as const }),
    readdir: async () => [],
    exists: async () => false,
    mkdir: async () => {},
    rm: async () => {},
    exec: async () => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 0,
    }),
  },
});

const allow = () => Effect.succeed({ ok: true as const });

describe("workspace session substrate contract", () => {
  it("lowers staged permission input to the existing workspace tool policy", () => {
    const session = defineWorkspaceSessionLease({
      identity: { scope: "repo", runId: "run-1", workspaceRef: env.domain.ref },
      env,
      repo: { repoRef: "repo:zeroY3", root: "/workspace" },
      permissions: {
        phaseRef: "change",
        policy: {
          toolNames: ["read_file", "write_file"],
          mutationPolicy: "receipt-backed",
          toolInteractions: { write_file: "approval" },
        },
      },
      resourceLimits: {
        maxFileBytes: 10_000,
        maxCommandChars: 500,
        execTimeoutMs: 2_000,
        maxOutputBytes: 4_000,
      },
    });

    expect(session.identity).toEqual({
      scope: "repo",
      runId: "run-1",
      workspaceRef: "workspace:session",
    });
    expect(session.repo).toEqual({ repoRef: "repo:zeroY3", root: "/workspace" });
    expect(workspaceSessionToolPolicy(session)).toEqual(session.permissions?.policy);
    expect(workspaceSessionToolOptions(session)).toEqual({
      toolNames: ["read_file", "write_file"],
      mutationPolicy: "receipt-backed",
      toolInteractions: { write_file: "approval" },
      maxFileBytes: 10_000,
      maxCommandChars: 500,
      execTimeoutMs: 2_000,
      maxOutputBytes: 4_000,
    });

    const bindings = bindWorkspaceToolsForRuntime({
      env: session.env,
      authority: "agentos.test",
      admit: allow,
      ...workspaceSessionToolOptions(session),
    });

    expect(Object.keys(bindings.tools ?? {}).sort()).toEqual(["read_file", "write_file"]);
    expect(bindings.decisionInterrupts).toEqual([
      { toolName: "write_file", reason: "approval_required" },
    ]);
  });

  it("delegates terminal artifact readback to the workspace-job data plane", async () => {
    const calls: unknown[] = [];
    const session = defineWorkspaceSessionLease({
      identity: { scope: "repo", runId: "job-1", workspaceRef: env.domain.ref },
      env,
      artifactReadback: {
        readTerminalArtifact: async (input) => {
          calls.push(input);
          return "terminal bytes";
        },
      },
    });

    await expect(
      readWorkspaceSessionTerminalArtifact(session, {
        path: "/artifact/result.json",
        artifactRef: "artifact:result",
      }),
    ).resolves.toBe("terminal bytes");
    expect(calls).toEqual([
      { runId: "job-1", path: "/artifact/result.json", artifactRef: "artifact:result" },
    ]);
  });

  it("keeps cleanup as provider lease lifecycle and validates session inputs", async () => {
    const cleanupReasons: unknown[] = [];
    const session = defineWorkspaceSessionLease({
      identity: { scope: "repo", runId: "run-clean", workspaceRef: env.domain.ref },
      env,
      cleanup: async (input) => {
        cleanupReasons.push(input?.reason ?? "none");
      },
    });

    await cleanupWorkspaceSessionLease(session, { reason: "abandoned" });
    expect(cleanupReasons).toEqual(["abandoned"]);
    await expect(
      readWorkspaceSessionTerminalArtifact(session, {
        path: "/artifact/result.json",
        artifactRef: "artifact:result",
      }),
    ).rejects.toThrow("workspace session has no artifact readback provider");
    expect(() =>
      defineWorkspaceSessionLease({
        identity: { scope: "", runId: "run", workspaceRef: env.domain.ref },
        env,
      }),
    ).toThrow(WorkspaceSessionLifecycleError);
    expect(() =>
      defineWorkspaceSessionLease({
        identity: { scope: "repo", runId: "run", workspaceRef: env.domain.ref },
        env,
        resourceLimits: { execTimeoutMs: 0 },
      }),
    ).toThrow("workspace session resource limits must be positive");
  });
});
