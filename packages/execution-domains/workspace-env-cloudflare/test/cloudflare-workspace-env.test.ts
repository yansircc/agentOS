import { describe, expect, it, vi } from "@effect/vitest";

import { makeCloudflareWorkspaceEnv, type CloudflareWorkspaceEnvClient } from "../src";

describe("@agent-os/workspace-env-cloudflare", () => {
  it("maps Cloudflare-compatible file and exec methods into WorkspaceEnv", async () => {
    const exec = vi.fn<CloudflareWorkspaceEnvClient["exec"]>(async (_command, _options) => ({
      exitCode: 0,
      stdout: "done",
      stderr: "",
      durationMs: 3,
    }));
    const client: CloudflareWorkspaceEnvClient = {
      id: "cf-1",
      exec,
      readFile: async () => ({ content: "hello" }),
      writeFile: vi.fn(async () => undefined),
      mkdir: vi.fn(async () => undefined),
      readdir: vi.fn(async () => ["a.ts"]),
      rm: vi.fn(async () => undefined),
      exists: async () => true,
      stat: async () => ({ type: "file", size: 5 }),
    };
    const env = makeCloudflareWorkspaceEnv({ client, cwd: "/workspace/project" });
    const controller = new AbortController();

    expect(env.domain).toEqual({ kind: "sandbox", ref: "cf-1" });
    await env.writeFile("src/a.ts", "hello", { signal: controller.signal });
    await expect(env.readFile("src/a.ts", { signal: controller.signal })).resolves.toBe("hello");
    await expect(env.readdir("src", { signal: controller.signal })).resolves.toEqual(["a.ts"]);
    await expect(
      env.exec("npm test", {
        timeoutMs: 12_000,
        maxOutputBytes: 10,
        signal: controller.signal,
      }),
    ).resolves.toEqual({
      exitCode: 0,
      stdout: "done",
      stderr: "",
      stdoutBytes: 4,
      stderrBytes: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 3,
    });

    expect(client.mkdir).toHaveBeenCalledWith("/workspace/project/src", {
      recursive: true,
    });
    expect(client.writeFile).toHaveBeenCalledWith("/workspace/project/src/a.ts", "hello", {
      encoding: "utf-8",
    });
    expect(exec).toHaveBeenCalledWith("npm test", {
      cwd: "/workspace/project",
      timeout: 12_000,
      timeoutMs: 12_000,
    });
  });

  it("rejects before invoking provider methods when signal is already aborted", async () => {
    const writeFile = vi.fn(async () => undefined);
    const client: CloudflareWorkspaceEnvClient = {
      exec: async () => ({ exitCode: 0 }),
      writeFile,
      mkdir: vi.fn(async () => undefined),
      readFile: async () => "",
    };
    const env = makeCloudflareWorkspaceEnv({ client });
    const controller = new AbortController();
    controller.abort("stop");

    await expect(env.writeFile("a.txt", "a", { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
      message: "stop",
    });
    expect(writeFile).not.toHaveBeenCalled();
  });
});
