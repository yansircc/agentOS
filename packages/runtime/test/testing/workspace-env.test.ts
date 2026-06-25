import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { createInMemoryWorkspaceEnv, InMemoryWorkspaceEnvError } from "@agent-os/runtime/testing";

const withHostTempDir = async <A>(run: (root: string) => Promise<A>): Promise<A> => {
  const root = await mkdtemp(path.join(tmpdir(), "agentos-in-memory-workspace-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

describe("createInMemoryWorkspaceEnv", () => {
  it("wraps deterministic in-memory files in the shared workspace root contract", async () => {
    const env = createInMemoryWorkspaceEnv({
      files: {
        "README.md": "hello",
        "src/index.ts": textBytes("export const value = 1;\n"),
      },
    });

    await env.writeFile("dist/result.txt", "done");
    await env.mkdir("empty");

    expect(env.cwd).toBe("/workspace");
    expect(env.resolvePath("./src/index.ts")).toBe("/workspace/src/index.ts");
    await expect(env.readFile("README.md")).resolves.toBe("hello");
    await expect(env.readFile("./dist/result.txt")).resolves.toBe("done");
    await expect(env.exists("dist/result.txt")).resolves.toBe(true);
    await expect(env.stat("src")).resolves.toMatchObject({ type: "directory" });
    await expect(env.stat("src/index.ts")).resolves.toMatchObject({ type: "file", size: 24 });
    await expect(env.readdir(".")).resolves.toEqual(["README.md", "dist", "empty", "src"]);

    const buffer = await env.readFileBuffer("src/index.ts");
    buffer[0] = "X".charCodeAt(0);
    await expect(env.readFile("src/index.ts")).resolves.toBe("export const value = 1;\n");

    await env.rm("dist", { recursive: true });
    await expect(env.exists("dist/result.txt")).resolves.toBe(false);
  });

  it("keeps host files outside the in-memory backend even when cwd is a real directory", async () => {
    await withHostTempDir(async (root) => {
      await writeFile(path.join(root, "host-only.txt"), "host file", "utf8");
      const env = createInMemoryWorkspaceEnv({
        cwd: root,
        files: { "seeded.txt": "seeded file" },
      });

      await expect(env.readFile("seeded.txt")).resolves.toBe("seeded file");
      await expect(env.readFile("host-only.txt")).rejects.toThrow(
        "in-memory workspace path not found",
      );
      expect(() => env.resolvePath("../outside.txt")).toThrow("escape root");
    });
  });

  it("runs only exact scripted commands and reports byte truncation deterministically", async () => {
    const env = createInMemoryWorkspaceEnv({
      scripts: {
        "pnpm test": {
          exitCode: 2,
          stdout: "abcdef",
          stderr: "warning",
          durationMs: 7,
        },
      },
    });

    const result = await env.exec("pnpm test", { timeoutMs: 1_000, maxOutputBytes: 3 });

    expect(result).toEqual({
      exitCode: 2,
      stdout: "abc",
      stderr: "war",
      stdoutBytes: 6,
      stderrBytes: 7,
      stdoutTruncated: true,
      stderrTruncated: true,
      durationMs: 7,
    });
    await expect(env.exec("pnpm test ", { timeoutMs: 1_000 })).rejects.toThrow(
      "no script for command",
    );
  });

  it("rejects symbolic refs instead of resolving host environment or material state", async () => {
    const env = createInMemoryWorkspaceEnv({
      scripts: {
        "echo ok": { stdout: "ok" },
      },
    });

    await expect(
      env.exec("echo ok", {
        timeoutMs: 1_000,
        envRefs: { API_KEY: "secret:api-key" },
      }),
    ).rejects.toThrow("symbolic env refs");
    await expect(
      env.exec("echo ok", {
        timeoutMs: 1_000,
        materialRefs: ["material:workspace"],
      }),
    ).rejects.toThrow("symbolic material refs");
  });

  it("uses a public error class for fail-closed backend failures", async () => {
    const env = createInMemoryWorkspaceEnv();

    await expect(env.exec("missing", { timeoutMs: 1_000 })).rejects.toBeInstanceOf(
      InMemoryWorkspaceEnvError,
    );
  });
});

const textBytes = (text: string): Uint8Array => new TextEncoder().encode(text);
