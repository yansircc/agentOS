import { Effect } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { deterministicToolInvocation, runToolByName } from "@agent-os/kernel";

import {
  createWorkspaceEnv,
  createWorkspaceTools,
  type WorkspaceEnvBackend,
  type WorkspaceExecOptions,
  type WorkspaceExecResult,
} from "../src";

const execResult = (overrides: Partial<WorkspaceExecResult> = {}): WorkspaceExecResult => ({
  exitCode: 0,
  stdout: "ok",
  stderr: "",
  stdoutBytes: 2,
  stderrBytes: 0,
  stdoutTruncated: false,
  stderrTruncated: false,
  durationMs: 1,
  ...overrides,
});

const createBackend = () => {
  const files = new Map<string, string>();
  const dirs = new Set<string>(["/workspace"]);
  const execCalls: Array<{ readonly command: string; readonly options: WorkspaceExecOptions }> = [];
  const backend: WorkspaceEnvBackend = {
    readFile: async (path) => files.get(path) ?? "",
    readFileBuffer: async (path) => new TextEncoder().encode(files.get(path) ?? ""),
    writeFile: async (path, content) => {
      files.set(path, content instanceof Uint8Array ? new TextDecoder().decode(content) : content);
    },
    stat: async (path) => ({
      type: dirs.has(path) ? "directory" : "file",
      size: files.get(path)?.length ?? 0,
    }),
    readdir: async (path) => {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      return [...files.keys()]
        .filter((file) => file.startsWith(prefix))
        .map((file) => file.slice(prefix.length).split("/")[0]!)
        .filter((entry, index, entries) => entries.indexOf(entry) === index)
        .sort();
    },
    exists: async (path) => files.has(path) || dirs.has(path),
    mkdir: async (path) => {
      dirs.add(path);
    },
    rm: async (path) => {
      files.delete(path);
      dirs.delete(path);
    },
    exec: async (command, options) => {
      execCalls.push({ command, options });
      return execResult({ stdout: command });
    },
  };
  return { backend, files, execCalls };
};

const workspace = () => {
  const state = createBackend();
  const env = createWorkspaceEnv({
    cwd: "/workspace",
    domain: { kind: "workspace", ref: "test-workspace" },
    backend: state.backend,
  });
  return { ...state, env };
};

describe("@agent-os/workspace-env", () => {
  it("normalizes workspace paths and rejects escape attempts", () => {
    const { env } = workspace();

    expect(env.resolvePath("src/./index.ts")).toBe("/workspace/src/index.ts");
    expect(env.resolvePath("/workspace/src/index.ts")).toBe("/workspace/src/index.ts");
    expect(() => env.resolvePath("../secrets")).toThrow("cannot escape");
    expect(() => env.resolvePath("/other/secrets")).toThrow("cannot escape");
  });

  it.effect("generates workspace tools from one actuator", () =>
    Effect.gen(function* () {
      const { env, files, execCalls } = workspace();
      const writes: unknown[] = [];
      const execs: unknown[] = [];
      const tools = createWorkspaceTools(env, {
        authority: "test.workspace",
        admit: "allow",
        hooks: {
          onAfterWrite: (input) => {
            writes.push(input);
          },
          onAfterExec: (input) => {
            execs.push(input);
          },
        },
      });

      yield* runToolByName(
        tools,
        deterministicToolInvocation("write_file", {
          path: "src/pingpong.py",
          content: "def ping():\n    return 'pong'\n",
        }),
      );
      const read = yield* runToolByName(
        tools,
        deterministicToolInvocation("read_file", { path: "src/pingpong.py" }),
      );
      const list = yield* runToolByName(
        tools,
        deterministicToolInvocation("list_files", { path: "src" }),
      );
      const shell = yield* runToolByName(
        tools,
        deterministicToolInvocation("run_shell", {
          command: "python3 -m py_compile src/pingpong.py",
          envRefs: [{ name: "TOKEN", ref: "credential:token" }],
          materialRefs: ["credential:token"],
        }),
      );

      expect(files.get("/workspace/src/pingpong.py")).toContain("pong");
      expect(read).toEqual({
        path: "src/pingpong.py",
        content: "def ping():\n    return 'pong'\n",
        encoding: "utf-8",
        size: 30,
      });
      expect(list).toEqual({ path: "src", entries: ["pingpong.py"] });
      expect(shell).toEqual(
        expect.objectContaining({
          command: "python3 -m py_compile src/pingpong.py",
          cwd: ".",
          exitCode: 0,
        }),
      );
      expect(execCalls[0]?.options.signal).toBeInstanceOf(AbortSignal);
      expect(execCalls[0]?.options.envRefs).toEqual({ TOKEN: "credential:token" });
      expect(writes).toEqual([{ path: "src/pingpong.py", bytes: 30 }]);
      expect(execs).toEqual([
        {
          command: "python3 -m py_compile src/pingpong.py",
          cwd: ".",
          exitCode: 0,
          stdoutBytes: 2,
          stderrBytes: 0,
          durationMs: 1,
        },
      ]);
    }),
  );

  it("fails tool execution when observation hook fails", async () => {
    const { env } = workspace();
    const tools = createWorkspaceTools(env, {
      authority: "test.workspace",
      admit: "allow",
      hooks: {
        onAfterWrite: () => {
          throw new Error("projection failed");
        },
      },
    });

    await expect(
      tools.write_file!.execute(
        {
          path: "a.txt",
          content: "a",
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow("projection failed");
  });
});
