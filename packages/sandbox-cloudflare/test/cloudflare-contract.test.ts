import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, TestClock } from "effect";

import { runSandbox, staticPolicy } from "@agent-os/sandbox";
import {
  makeCloudflareSandboxBackend,
  type CloudflareSandboxClient,
  type CloudflareSandboxExecOptions,
  type CloudflareSandboxExecResult,
} from "../src/index";

describe("@agent-os/sandbox-cloudflare backend", () => {
  it.effect("executes via the supplied Cloudflare-compatible sandbox client", () =>
    Effect.gen(function* () {
      const calls: Array<{
        readonly command: string;
        readonly options: CloudflareSandboxExecOptions | undefined;
      }> = [];
      const client: CloudflareSandboxClient = {
        id: "cf-1",
        exec: (command, options) => {
          calls.push({ command, options });
          return Promise.resolve({
            exitCode: 0,
            stdout: "ok",
            stderr: "",
          });
        },
      };
      const backend = makeCloudflareSandboxBackend({
        getSandbox: () => client,
      });

      const result = yield* runSandbox(backend, staticPolicy(), {
        command: "ls",
        args: ["-la"],
        cwd: "/workspace",
        timeoutMs: 1_000,
      });

      expect(result).toMatchObject({
        exitCode: 0,
        stdout: "ok",
        stderr: "",
        sandboxId: "cf-1",
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.command).toBe("ls");
      expect(calls[0]?.options).toMatchObject({
        args: ["-la"],
        cwd: "/workspace",
        timeoutMs: 1_000,
      });
      expect(calls[0]?.options?.signal).toBeInstanceOf(AbortSignal);
    }),
  );

  it.effect("writes supplied files before exec", () =>
    Effect.gen(function* () {
      const writes: unknown[] = [];
      const client: CloudflareSandboxClient = {
        id: "cf-files",
        writeFile: (path, content) => {
          writes.push({ path, content });
          return Promise.resolve();
        },
        exec: () => Promise.resolve({ exitCode: 0, stdout: "done", stderr: "" }),
      };
      const backend = makeCloudflareSandboxBackend({
        getSandbox: () => client,
      });

      yield* runSandbox(backend, staticPolicy(), {
        command: "node",
        args: ["app.js"],
        files: { "app.js": "console.log(1)" },
        timeoutMs: 1_000,
      });

      expect(writes).toEqual([{ path: "app.js", content: "console.log(1)" }]);
    }),
  );

  it.effect("classifies not-found/destroyed backend errors as SandboxEvicted", () =>
    Effect.gen(function* () {
      const client: CloudflareSandboxClient = {
        id: "cf-dead",
        exec: () => Promise.reject(new Error("404 sandbox not found")),
      };
      const backend = makeCloudflareSandboxBackend({
        getSandbox: () => client,
      });

      const result = yield* runSandbox(backend, staticPolicy(), {
        command: "ls",
        timeoutMs: 1_000,
      }).pipe(Effect.either);

      expect(result._tag).toBe("Left");
      if (result._tag === "Left" && result.left._tag === "agent_os.sandbox_failure") {
        expect(result.left.code).toBe("SandboxEvicted");
        expect(result.left.sandboxId).toBe("cf-dead");
      }
    }),
  );

  it.effect("aborts the provider exec signal when algebra timeout fires", () =>
    Effect.gen(function* () {
      let signal: AbortSignal | undefined;
      let aborted = false;
      const client: CloudflareSandboxClient = {
        id: "cf-timeout",
        exec: (_command, options) => {
          signal = options?.signal;
          signal?.addEventListener("abort", () => {
            aborted = true;
          });
          return new Promise<CloudflareSandboxExecResult>(() => undefined);
        },
      };
      const backend = makeCloudflareSandboxBackend({
        getSandbox: () => client,
      });

      const fiber = yield* runSandbox(backend, staticPolicy(), {
        command: "sleep",
        timeoutMs: 10,
      }).pipe(Effect.either, Effect.fork);
      yield* TestClock.adjust("11 millis");
      const result = yield* Fiber.join(fiber);

      expect(result._tag).toBe("Left");
      if (result._tag === "Left" && result.left._tag === "agent_os.sandbox_failure") {
        expect(result.left.code).toBe("Timeout");
      }
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(aborted).toBe(true);
    }),
  );

  it.effect("fails explicitly when files are requested but writeFile is absent", () =>
    Effect.gen(function* () {
      const client: CloudflareSandboxClient = {
        id: "cf-no-files",
        exec: () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
      };
      const backend = makeCloudflareSandboxBackend({
        getSandbox: () => client,
      });

      const result = yield* runSandbox(backend, staticPolicy(), {
        command: "cat",
        files: { "input.txt": "hello" },
        timeoutMs: 1_000,
      }).pipe(Effect.either);

      expect(result._tag).toBe("Left");
      if (result._tag === "Left" && result.left._tag === "agent_os.sandbox_failure") {
        expect(result.left.code).toBe("ProviderFailure");
        expect(result.left.reason).toContain("writeFile");
      }
    }),
  );
});
