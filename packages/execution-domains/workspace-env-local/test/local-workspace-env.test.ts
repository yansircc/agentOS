import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { createWorkspaceTools } from "@agent-os/workspace-env";
import { deterministicToolInvocation, unsafeRunToolByName } from "@agent-os/kernel";

import { makeLocalWorkspaceEnv, makeTemporaryLocalWorkspaceEnv } from "../src";

const allowToolAdmitter = () => Effect.succeed({ ok: true as const });

const roots: string[] = [];

const mkRoot = async (): Promise<string> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-os-local-workspace-test-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("@agent-os/workspace-env-local", () => {
  it("maps WorkspaceEnv file and shell operations into one explicit host root", async () => {
    const rootDir = await mkRoot();
    const env = makeLocalWorkspaceEnv({
      rootDir,
      env: { SECRET: "hidden", PATH: process.env.PATH },
      envAllowlist: ["PATH"],
    });

    await env.writeFile("src/pingpong.py", "def ping():\n    return 'pong'\n");
    await expect(env.readFile("/workspace/src/pingpong.py")).resolves.toContain("pong");
    await expect(env.readdir("src")).resolves.toEqual(["pingpong.py"]);
    await expect(fs.readFile(path.join(rootDir, "src/pingpong.py"), "utf8")).resolves.toContain(
      "pong",
    );
    expect(() => env.resolvePath("../secret")).toThrow("cannot escape");

    const visibleEnv = await env.exec('printf "$SECRET"', {
      timeoutMs: 1_000,
      maxOutputBytes: 128,
    });
    expect(visibleEnv.stdout).toBe("");

    const compile = await env.exec("python3 -m py_compile src/pingpong.py", {
      timeoutMs: 5_000,
      maxOutputBytes: 512,
    });
    expect(compile.exitCode).toBe(0);
    expect(env.domain).toEqual({
      kind: "host",
      ref: `local:${rootDir}`,
      envAllowlist: ["PATH"],
    });
  });

  it.effect("runs generated workspace tools with an explicit host execution domain", () =>
    Effect.gen(function* () {
      const rootDir = yield* Effect.promise(() => mkRoot());
      const env = makeLocalWorkspaceEnv({ rootDir, envAllowlist: [] });
      const tools = createWorkspaceTools(env, {
        authority: "test.local-workspace",
        admit: allowToolAdmitter,
      });

      yield* unsafeRunToolByName(
        tools,
        deterministicToolInvocation("write_file", {
          path: "README.md",
          content: "hello",
        }),
      );
      const shell = yield* unsafeRunToolByName(
        tools,
        deterministicToolInvocation("run_shell", {
          command: "printf ok",
          timeoutMs: 1_000,
        }),
      );

      expect(tools.run_shell?.execution).toEqual({
        kind: "external",
        access: "write",
        domain: {
          kind: "host",
          ref: `local:${rootDir}`,
          envAllowlist: [],
        },
      });
      expect(shell).toEqual(
        expect.objectContaining({
          command: "printf ok",
          cwd: ".",
          exitCode: 0,
          stdout: "ok",
        }),
      );
    }),
  );

  it("times out finite shell commands and aborts on caller signal", async () => {
    const rootDir = await mkRoot();
    const env = makeLocalWorkspaceEnv({ rootDir });

    await expect(
      env.exec("while true; do :; done", {
        timeoutMs: 20,
        maxOutputBytes: 256,
      }),
    ).resolves.toMatchObject({
      exitCode: 124,
      stderr: expect.stringContaining("timed out"),
    });

    const controller = new AbortController();
    const run = env.exec("while true; do :; done", {
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    controller.abort("stop");
    await expect(run).rejects.toMatchObject({ name: "AbortError", message: "stop" });
  });

  it("creates temporary local workspaces without promoting a hidden fallback", async () => {
    const created = await makeTemporaryLocalWorkspaceEnv({ envAllowlist: [] });
    roots.push(created.rootDir);

    await created.env.writeFile("a.txt", "a");
    await expect(fs.readFile(path.join(created.rootDir, "a.txt"), "utf8")).resolves.toBe("a");
    expect(created.env.domain).toEqual({
      kind: "host",
      ref: `local:${created.rootDir}`,
      envAllowlist: [],
    });
  });
});
