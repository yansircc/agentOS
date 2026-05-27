import { describe, expect, it } from "vite-plus/test";
import { Effect, Fiber, Layer, Logger, TestClock } from "effect";
import * as TestContext from "effect/TestContext";
import type * as TestServices from "effect/TestServices";

import {
  makeSandboxRunTool,
  runSandbox,
  SandboxFailure,
  staticPolicy,
  type SandboxBackend,
} from "../src/index";

const backend = (impl: SandboxBackend["run"]): SandboxBackend => ({ run: impl });

const TestEnv = TestContext.TestContext.pipe(Layer.provide(Logger.remove(Logger.defaultLogger)));

const runEffect = <A, E>(effect: Effect.Effect<A, E, TestServices.TestServices>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, TestEnv));

describe("@agent-os/sandbox v0 contract", () => {
  it("runs one bounded stateless command", () =>
    runEffect(
      Effect.gen(function* () {
        const result = yield* runSandbox(
          backend((request) =>
            Effect.succeed({
              exitCode: 0,
              stdout: `ran:${request.command}`,
              stderr: "",
              artifacts: [],
              sandboxId: "sbx-1",
            }),
          ),
          staticPolicy(),
          { command: "ls", timeoutMs: 1_000 },
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("ran:ls");
        expect(result.sandboxId).toBe("sbx-1");
      }),
    ));

  it("policy denial is typed PolicyDenied", () =>
    runEffect(
      Effect.gen(function* () {
        const result = yield* runSandbox(
          backend(() =>
            Effect.succeed({
              exitCode: 0,
              stdout: "",
              stderr: "",
              artifacts: [],
              sandboxId: "never",
            }),
          ),
          staticPolicy({ allowNetwork: false }),
          {
            command: "curl",
            timeoutMs: 1_000,
            network: { mode: "allowlist", hosts: ["example.com"] },
          },
        ).pipe(Effect.either);

        expect(result._tag).toBe("Left");
        if (result._tag === "Left") {
          expect(result.left._tag).toBe("agent_os.sandbox_policy_denied");
          expect(result.left.reason).toBe("network is disabled");
        }
      }),
    ));

  it("allowlist policy rejects hosts outside the allowed set", () =>
    runEffect(
      Effect.gen(function* () {
        const result = yield* runSandbox(
          backend(() =>
            Effect.succeed({
              exitCode: 0,
              stdout: "",
              stderr: "",
              artifacts: [],
              sandboxId: "never",
            }),
          ),
          staticPolicy({ allowNetwork: ["allowed.com"] }),
          {
            command: "curl",
            timeoutMs: 1_000,
            network: { mode: "allowlist", hosts: ["blocked.com"] },
          },
        ).pipe(Effect.either);

        expect(result._tag).toBe("Left");
        if (result._tag === "Left") {
          expect(result.left._tag).toBe("agent_os.sandbox_policy_denied");
          expect(result.left.reason).toContain("blocked.com");
        }
      }),
    ));

  it("times out when the backend does not complete before timeoutMs", () =>
    runEffect(
      Effect.gen(function* () {
        const fiber = yield* runSandbox(
          backend(() => Effect.never),
          staticPolicy(),
          { command: "sleep", timeoutMs: 10 },
        ).pipe(Effect.either, Effect.fork);
        yield* TestClock.adjust("11 millis");
        const result = yield* Fiber.join(fiber);

        expect(result._tag).toBe("Left");
        if (result._tag === "Left" && result.left._tag === "agent_os.sandbox_failure") {
          expect(result.left.code).toBe("Timeout");
          expect(result.left.reason).toContain("10ms");
        }
      }),
    ));

  it("provider eviction is typed SandboxEvicted", () =>
    runEffect(
      Effect.gen(function* () {
        const result = yield* runSandbox(
          backend(() =>
            Effect.fail(
              new SandboxFailure({
                code: "SandboxEvicted",
                reason: "sandbox was evicted",
                sandboxId: "sbx-dead",
              }),
            ),
          ),
          staticPolicy(),
          { command: "ls", timeoutMs: 1_000 },
        ).pipe(Effect.either);

        expect(result._tag).toBe("Left");
        if (result._tag === "Left" && result.left._tag === "agent_os.sandbox_failure") {
          expect(result.left.code).toBe("SandboxEvicted");
          expect(result.left.sandboxId).toBe("sbx-dead");
        }
      }),
    ));

  it("tool helper byte-caps stdout and preserves explicit truncation facts", () =>
    runEffect(
      Effect.gen(function* () {
        const tool = makeSandboxRunTool({
          backend: backend(() =>
            Effect.succeed({
              exitCode: 0,
              stdout: "x".repeat(20),
              stderr: "y".repeat(5),
              artifacts: [],
              sandboxId: "sbx-big",
            }),
          ),
          policy: staticPolicy(),
          maxOutputBytes: 8,
        });

        const result = yield* Effect.promise(() => tool.execute({ command: "make big-output" }));

        expect(result.ok).toBe(true);
        expect(result.stdoutBytes).toBe(20);
        expect(result.stdoutHead).toBe("x".repeat(8));
        expect(result.stdoutTruncated).toBe(true);
        expect(result.stderrBytes).toBe(5);
        expect(result.stderrTruncated).toBe(false);
        expect(result.artifacts).toEqual([]);
      }),
    ));

  it("tool helper returns one fresh run result per invocation", () =>
    runEffect(
      Effect.gen(function* () {
        let calls = 0;
        const tool = makeSandboxRunTool({
          backend: backend(() =>
            Effect.sync(() => {
              calls += 1;
              return {
                exitCode: 0,
                stdout: "",
                stderr: "",
                artifacts: [],
                sandboxId: `sbx-${calls}`,
              };
            }),
          ),
          policy: staticPolicy(),
        });

        const first = yield* Effect.promise(() => tool.execute({ command: "pwd" }));
        const second = yield* Effect.promise(() => tool.execute({ command: "pwd" }));

        expect(first.sandboxId).toBe("sbx-1");
        expect(second.sandboxId).toBe("sbx-2");
      }),
    ));
});
