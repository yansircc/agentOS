import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { describe, expect, it } from "@effect/vitest";
import { RUNTIME_EVENT_KIND } from "@agent-os/core/runtime-protocol";
import { createLocalAgentRuntime, createLocalWorkspaceEnv } from "@agent-os/runtime/local";

const withTempWorkspace = async <A>(run: (root: string, base: string) => Promise<A>): Promise<A> => {
  const base = await mkdtemp(path.join(tmpdir(), "agentos-local-workspace-"));
  const root = path.join(base, "workspace");
  await mkdir(root);
  try {
    return await run(root, base);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
};

const nodeCommand = (script: string): string =>
  `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;

describe("createLocalWorkspaceEnv", () => {
  it("wraps local filesystem operations in the shared workspace root contract", async () => {
    await withTempWorkspace(async (root, base) => {
      const env = createLocalWorkspaceEnv({ cwd: root });

      await env.writeFile("nested/result.txt", "done");

      await expect(env.readFile("./nested/result.txt")).resolves.toBe("done");
      await expect(env.exists("nested/result.txt")).resolves.toBe(true);
      await expect(env.stat("nested")).resolves.toMatchObject({ type: "directory" });
      await expect(env.readdir(".")).resolves.toEqual(["nested"]);
      await expect(env.writeFile("../outside.txt", "escape")).rejects.toThrow("escape root");
      await expect(readFile(path.join(base, "outside.txt"), "utf8")).rejects.toThrow();
    });
  });

  it("runs commands with explicit env only unless inheritEnv is enabled", async () => {
    await withTempWorkspace(async (root) => {
      const env = createLocalWorkspaceEnv({
        cwd: root,
        env: { AGENTOS_LOCAL_ONLY: "set" },
        inheritEnv: false,
      });

      const result = await env.exec(
        nodeCommand(
          [
            "process.stdout.write(process.env.AGENTOS_LOCAL_ONLY ?? 'missing');",
            "process.stderr.write(process.env.PATH === undefined ? 'no-path' : 'path');",
          ].join(""),
        ),
        { timeoutMs: 5_000 },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("set");
      expect(result.stderr).toBe("no-path");
    });
  });

  it("fails closed for symbolic env and material refs", async () => {
    await withTempWorkspace(async (root) => {
      const env = createLocalWorkspaceEnv({ cwd: root });

      await expect(
        env.exec("echo no-env-ref-resolution", {
          timeoutMs: 5_000,
          envRefs: { API_KEY: "secret:api-key" },
        }),
      ).rejects.toThrow("symbolic env refs");
      await expect(
        env.exec("echo no-material-ref-resolution", {
          timeoutMs: 5_000,
          materialRefs: ["material:workspace"],
        }),
      ).rejects.toThrow("symbolic material refs");
    });
  });

  it("reports bytes and truncation for command output", async () => {
    await withTempWorkspace(async (root) => {
      const env = createLocalWorkspaceEnv({ cwd: root });

      const result = await env.exec(nodeCommand("process.stdout.write('abcdef');"), {
        timeoutMs: 5_000,
        maxOutputBytes: 3,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("abc");
      expect(result.stdoutBytes).toBe(6);
      expect(result.stdoutTruncated).toBe(true);
    });
  });

  it("creates a local agent runtime over resolveRuntime and private submitAgentEffect", async () => {
    await withTempWorkspace(async (root) => {
      const runtime = await createLocalAgentRuntime({
        identity: "local-runtime",
        cwd: root,
        llm: {
          responses: [
            {
              items: [{ type: "message", text: "local done" }],
              usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
            },
          ],
        },
      });

      expect(Object.keys(runtime).sort()).toEqual(["diagnostics", "events", "submit"]);
      const result = await runtime.submit({ intent: "finish locally" });

      expect(result).toMatchObject({
        ok: true,
        status: "delivered",
        final: "local done",
        tokensUsed: 3,
      });
      expect(runtime.diagnostics()).toEqual([]);
      expect(runtime.events().map((event) => event.kind)).toEqual(
        expect.arrayContaining([
          RUNTIME_EVENT_KIND.AGENT_RUN_STARTED,
          RUNTIME_EVENT_KIND.LLM_REQUESTED,
          RUNTIME_EVENT_KIND.LLM_RESPONSE,
          RUNTIME_EVENT_KIND.AGENT_RUN_COMPLETED,
        ]),
      );
    });
  });
});
