import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { bindWorkspaceToolsForRuntime, createWorkspaceEnv } from "../src";

const env = createWorkspaceEnv({
  domain: { kind: "workspace", ref: "workspace:test" },
  cwd: "/tmp/agentos-workspace-binding-test",
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

describe("workspace runtime binding", () => {
  it("derives default decision interrupts from declared interaction floors", () => {
    const bindings = bindWorkspaceToolsForRuntime({
      env,
      authority: "agentos.test",
      admit: allow,
      toolNames: ["read_file", "write_file"],
      mutationPolicy: "receipt-backed",
      toolInteractions: { write_file: "approval" },
    });

    expect(bindings.decisionInterrupts).toEqual([
      { toolName: "write_file", reason: "approval_required" },
    ]);
  });

  it("does not invent decision interrupts without an approval floor", () => {
    const bindings = bindWorkspaceToolsForRuntime({
      env,
      authority: "agentos.test",
      admit: allow,
      toolNames: ["write_file"],
      mutationPolicy: "receipt-backed",
    });

    expect(bindings.decisionInterrupts).toBeUndefined();
  });
});
