import { Effect } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { deterministicToolInvocation, unsafeRunToolByName } from "@agent-os/kernel";

import {
  createWorkspaceEnv,
  createWorkspaceTools,
  diffWorkspaceFiles,
  editWorkspaceFile,
  globWorkspaceFiles,
  grepWorkspaceFiles,
  walkWorkspaceFiles,
  type WorkspaceEnvBackend,
  type WorkspaceExecOptions,
  type WorkspaceExecResult,
} from "../src";

const allowToolAdmitter = () => ({ ok: true as const });

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
  const isDir = (path: string): boolean =>
    dirs.has(path) || [...files.keys()].some((file) => file.startsWith(`${path}/`));
  const ensureDir = (path: string): void => {
    const parts = path.split("/").filter((part) => part.length > 0);
    let current = "";
    for (const part of parts) {
      current = `${current}/${part}`;
      dirs.add(current);
    }
  };
  const backend: WorkspaceEnvBackend = {
    readFile: async (path) => files.get(path) ?? "",
    readFileBuffer: async (path) => new TextEncoder().encode(files.get(path) ?? ""),
    writeFile: async (path, content) => {
      files.set(path, content instanceof Uint8Array ? new TextDecoder().decode(content) : content);
    },
    stat: async (path) => ({
      type: isDir(path) ? "directory" : files.has(path) ? "file" : "other",
      size: files.get(path)?.length ?? 0,
    }),
    readdir: async (path) => {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const entries = new Set<string>();
      for (const file of files.keys()) {
        if (file.startsWith(prefix)) entries.add(file.slice(prefix.length).split("/")[0]!);
      }
      for (const dir of dirs) {
        if (dir !== path && dir.startsWith(prefix))
          entries.add(dir.slice(prefix.length).split("/")[0]!);
      }
      return [...entries].sort();
    },
    exists: async (path) => files.has(path) || dirs.has(path),
    mkdir: async (path, options) => {
      if (options?.recursive === true) ensureDir(path);
      else dirs.add(path);
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

  it("walks workspace files deterministically and diffs pure snapshots", async () => {
    const { env } = workspace();
    await env.writeFile("src/a.ts", "a");
    await env.writeFile("src/deep/b.ts", "b");
    await env.writeFile("src/.secret", "s");
    await env.writeFile(".hidden.txt", "h");

    await expect(walkWorkspaceFiles(env, { root: "../outside" })).rejects.toThrow("cannot escape");

    await expect(walkWorkspaceFiles(env)).resolves.toEqual([
      { path: "src/a.ts", size: 1 },
      { path: "src/deep/b.ts", size: 1 },
    ]);
    await expect(walkWorkspaceFiles(env, { root: "src", recursive: false })).resolves.toEqual([
      { path: "src/a.ts", size: 1 },
    ]);
    await expect(walkWorkspaceFiles(env, { includeHidden: true })).resolves.toEqual([
      { path: ".hidden.txt", size: 1 },
      { path: "src/.secret", size: 1 },
      { path: "src/a.ts", size: 1 },
      { path: "src/deep/b.ts", size: 1 },
    ]);

    const diff = diffWorkspaceFiles(
      ["old.ts", "src/a.ts"],
      [
        { path: "src/deep/b.ts", size: 1 },
        { path: "src/a.ts", size: 1 },
      ],
    );
    expect(diff).toEqual({
      observedFiles: [
        { path: "src/a.ts", size: 1 },
        { path: "src/deep/b.ts", size: 1 },
      ],
      removedPaths: ["old.ts"],
    });
    expect(() => diffWorkspaceFiles([], [{ path: "same.ts" }, { path: "./same.ts" }])).toThrow(
      "duplicate current workspace path",
    );
  });

  it("edits workspace files by exact replacement count", async () => {
    const { env, files } = workspace();
    await env.writeFile("note.txt", "one two one");

    await expect(
      editWorkspaceFile(env, { path: "note.txt", oldString: "missing", newString: "x" }),
    ).rejects.toThrow("found 0");
    await expect(
      editWorkspaceFile(env, { path: "note.txt", oldString: "one", newString: "1" }),
    ).rejects.toThrow("found 2");
    await expect(
      editWorkspaceFile(env, {
        path: "note.txt",
        oldString: "two",
        newString: "three",
        expectCount: 0,
      }),
    ).rejects.toThrow("expectCount");

    await expect(
      editWorkspaceFile(env, {
        path: "note.txt",
        oldString: "one",
        newString: "1",
        expectCount: 2,
        maxFileBytes: 20,
      }),
    ).resolves.toEqual({ path: "note.txt", replacementCount: 2, bytesWritten: 7 });
    expect(files.get("/workspace/note.txt")).toBe("1 two 1");

    await expect(
      editWorkspaceFile(env, {
        path: "note.txt",
        oldString: "two",
        newString: "content that is too large",
        maxFileBytes: 8,
      }),
    ).rejects.toThrow("file exceeds");
  });

  it("globs and greps workspace files with bounded deterministic search semantics", async () => {
    const { env } = workspace();
    await expect(grepWorkspaceFiles(env, { pattern: "^", mode: "regex" })).rejects.toThrow(
      "cannot match empty",
    );
    await env.writeFile("src/a.ts", "alpha\nbeta\nalpha\n");
    await env.writeFile("src/b.ts", "betamax\n");
    await env.writeFile("src/.hidden.ts", "alpha\n");
    await env.writeFile("src/bin.dat", "alpha\0beta");
    await env.writeFile("src/long.txt", `prefix ${"x".repeat(20)} needle`);

    await expect(globWorkspaceFiles(env, { root: "../outside", pattern: "**/*" })).rejects.toThrow(
      "cannot escape",
    );
    await expect(globWorkspaceFiles(env, { root: "src", pattern: "**/*.ts" })).resolves.toEqual({
      root: "src",
      pattern: "**/*.ts",
      matches: ["src/a.ts", "src/b.ts"],
      truncated: false,
      maxMatches: 100,
    });
    await expect(
      globWorkspaceFiles(env, {
        root: "src",
        pattern: "**/*.ts",
        includeHidden: true,
        maxMatches: 1,
      }),
    ).resolves.toEqual({
      root: "src",
      pattern: "**/*.ts",
      matches: ["src/.hidden.ts"],
      truncated: true,
      maxMatches: 1,
    });

    const literal = await grepWorkspaceFiles(env, { root: "src", pattern: "alpha" });
    expect(
      literal.matches.map((match) => [match.path, match.lineNumber, match.columnNumber]),
    ).toEqual([
      ["src/a.ts", 1, 1],
      ["src/a.ts", 3, 1],
    ]);
    expect(literal.skippedBinaryPaths).toEqual(["src/bin.dat"]);

    const regex = await grepWorkspaceFiles(env, {
      root: "src",
      pattern: "beta\\w*",
      mode: "regex",
    });
    expect(regex.matches.map((match) => match.matchText)).toEqual(["beta", "betamax"]);

    const truncated = await grepWorkspaceFiles(env, {
      root: "src",
      pattern: "needle",
      maxBytesPerMatch: 12,
    });
    expect(truncated.matches).toEqual([
      expect.objectContaining({
        path: "src/long.txt",
        lineText: "prefix xxxxx",
        lineTextBytes: 12,
        lineTextTruncated: true,
        matchText: "needle",
        matchTextTruncated: false,
      }),
    ]);
  });

  it.effect("generates workspace tools from one actuator", () =>
    Effect.gen(function* () {
      const { env, files, execCalls } = workspace();
      const writes: unknown[] = [];
      const execs: unknown[] = [];
      const tools = createWorkspaceTools(env, {
        authority: "test.workspace",
        admit: allowToolAdmitter,
        hooks: {
          onAfterWrite: (input) => {
            writes.push(input);
          },
          onAfterExec: (input) => {
            execs.push(input);
          },
        },
      });

      yield* unsafeRunToolByName(
        tools,
        deterministicToolInvocation("write_file", {
          path: "src/pingpong.py",
          content: "def ping():\n    return 'pong'\n",
        }),
      );
      const read = yield* unsafeRunToolByName(
        tools,
        deterministicToolInvocation("read_file", { path: "src/pingpong.py" }),
      );
      const list = yield* unsafeRunToolByName(
        tools,
        deterministicToolInvocation("list_files", { path: "src" }),
      );
      const shell = yield* unsafeRunToolByName(
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
        contentBytes: 30,
        truncated: false,
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

  it.effect("bounds read_file output by UTF-8 bytes", () =>
    Effect.gen(function* () {
      const { env } = workspace();
      const tools = createWorkspaceTools(env, {
        authority: "test.workspace",
        admit: allowToolAdmitter,
        maxFileBytes: 5,
      });
      yield* Effect.promise(() => env.writeFile("unicode.txt", "αβγ"));

      const read = yield* unsafeRunToolByName(
        tools,
        deterministicToolInvocation("read_file", { path: "unicode.txt" }),
      );

      expect(read).toEqual({
        path: "unicode.txt",
        content: "αβ",
        encoding: "utf-8",
        size: 6,
        contentBytes: 4,
        truncated: true,
      });
    }),
  );

  it.effect("exposes edit_file glob_files and grep_files tools", () =>
    Effect.gen(function* () {
      const { env, files } = workspace();
      const writes: unknown[] = [];
      const tools = createWorkspaceTools(env, {
        authority: "test.workspace",
        admit: allowToolAdmitter,
        hooks: {
          onAfterWrite: (input) => {
            writes.push(input);
          },
        },
      });

      yield* unsafeRunToolByName(
        tools,
        deterministicToolInvocation("write_file", {
          path: "src/app.ts",
          content: "const value = 'old';\n",
        }),
      );
      const edit = yield* unsafeRunToolByName(
        tools,
        deterministicToolInvocation("edit_file", {
          path: "src/app.ts",
          oldString: "old",
          newString: "new",
        }),
      );
      const glob = yield* unsafeRunToolByName(
        tools,
        deterministicToolInvocation("glob_files", { root: "src", pattern: "*.ts" }),
      );
      const grep = yield* unsafeRunToolByName(
        tools,
        deterministicToolInvocation("grep_files", { root: "src", pattern: "new" }),
      );

      expect(edit).toEqual({ path: "src/app.ts", replacementCount: 1, bytesWritten: 21 });
      expect(glob).toEqual({
        root: "src",
        pattern: "*.ts",
        matches: ["src/app.ts"],
        truncated: false,
        maxMatches: 100,
      });
      expect(grep).toEqual(
        expect.objectContaining({
          root: "src",
          pattern: "new",
          mode: "literal",
          matches: [
            expect.objectContaining({
              path: "src/app.ts",
              lineNumber: 1,
              columnNumber: 16,
              matchText: "new",
            }),
          ],
        }),
      );
      expect(files.get("/workspace/src/app.ts")).toBe("const value = 'new';\n");
      expect(writes).toEqual([
        { path: "src/app.ts", bytes: 21 },
        { path: "src/app.ts", bytes: 21 },
      ]);
    }),
  );

  it("fails tool execution when observation hook fails", async () => {
    const { env } = workspace();
    const tools = createWorkspaceTools(env, {
      authority: "test.workspace",
      admit: allowToolAdmitter,
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
        { signal: new AbortController().signal, materials: {} },
      ),
    ).rejects.toThrow("projection failed");
  });
});
