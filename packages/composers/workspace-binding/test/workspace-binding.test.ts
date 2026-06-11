import { Effect } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { createWorkspaceEnv, type WorkspaceEnvBackend } from "@agent-os/workspace-env";
import { bindWorkspaceToolsForRuntime, workspaceEnvMaterialRef } from "../src";

const backend: WorkspaceEnvBackend = {
  readFile: async () => "",
  readFileBuffer: async () => new Uint8Array(),
  writeFile: async () => undefined,
  stat: async () => ({ type: "other" }),
  readdir: async () => [],
  exists: async () => false,
  mkdir: async () => undefined,
  rm: async () => undefined,
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
};

const env = createWorkspaceEnv({
  cwd: "/workspace",
  domain: { kind: "workspace", ref: "workspace:test" },
  backend,
});

describe("@agent-os/workspace-binding", () => {
  it("derives the workspace material ref from the workspace env domain", () => {
    expect(workspaceEnvMaterialRef(env)).toEqual({
      kind: "external_resource",
      provider: "agent-os",
      resourceKind: "workspace-env",
      ref: "workspace:test",
    });
  });

  it("defaults to read-only submit bindings with snapshot replay law", () => {
    const bindings = bindWorkspaceToolsForRuntime({
      env,
      authority: "test.workspace",
      admit: () => Effect.succeed({ ok: true }),
    });

    expect(Object.keys(bindings.tools ?? {}).sort()).toEqual([
      "glob_files",
      "grep_files",
      "list_files",
      "read_file",
    ]);
    expect(bindings.executionDomains).toEqual([
      { domain: env.domain, replay: { access: "read", witness: "snapshot" } },
    ]);
    expect(bindings.materials?.workspace).toEqual(workspaceEnvMaterialRef(env));
    expect(bindings.resolvedMaterials?.workspace).toBe(env);
    expect(bindings.tools).toBeDefined();
    expect((bindings.tools!.read_file as { readonly execution?: unknown }).execution).toEqual({
      kind: "external",
      access: "read",
      domain: env.domain,
    });
    expect("diagnostics" in bindings).toBe(false);
    expect("pathPolicy" in bindings).toBe(false);
    expect("externalExecutor" in bindings).toBe(false);
  });

  it("keeps mutation and shell tools disabled unless receipt-backed policy is explicit", () => {
    expect(() =>
      bindWorkspaceToolsForRuntime({
        env,
        authority: "test.workspace",
        admit: () => Effect.succeed({ ok: true }),
        exposure: ["read", "mutation"],
      }),
    ).toThrow("mutationPolicy");
    expect(() =>
      bindWorkspaceToolsForRuntime({
        env,
        authority: "test.workspace",
        admit: () => Effect.succeed({ ok: true }),
        exposure: ["shell"],
      }),
    ).toThrow("shellPolicy");

    const bindings = bindWorkspaceToolsForRuntime({
      env,
      authority: "test.workspace",
      admit: () => Effect.succeed({ ok: true }),
      exposure: ["mutation"],
      mutationPolicy: "receipt-backed",
    });

    expect(Object.keys(bindings.tools ?? {}).sort()).toEqual([
      "delete_path",
      "edit_file",
      "write_file",
    ]);
    expect(bindings.executionDomains).toEqual([
      { domain: env.domain, replay: { access: "write", witness: "receipt" } },
    ]);
    expect("externalExecutor" in bindings).toBe(false);
  });
});
