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

  it("returns submit bindings without diagnostics, path policy, or external executor", () => {
    const bindings = bindWorkspaceToolsForRuntime({
      env,
      authority: "test.workspace",
      admit: () => Effect.succeed({ ok: true }),
    });

    expect(Object.keys(bindings.tools ?? {}).sort()).toEqual([
      "delete_path",
      "edit_file",
      "glob_files",
      "grep_files",
      "list_files",
      "read_file",
      "run_shell",
      "write_file",
    ]);
    expect(bindings.materials?.workspace).toEqual(workspaceEnvMaterialRef(env));
    expect(bindings.resolvedMaterials?.workspace).toBe(env);
    expect(bindings.tools).toBeDefined();
    expect((bindings.tools!.write_file as { readonly execution?: unknown }).execution).toEqual({
      kind: "external",
      access: "write",
      domain: env.domain,
    });
    expect("diagnostics" in bindings).toBe(false);
    expect("pathPolicy" in bindings).toBe(false);
    expect("externalExecutor" in bindings).toBe(false);
  });
});
