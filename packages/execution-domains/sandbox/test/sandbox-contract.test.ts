import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

import {
  makeSandboxRunTool,
  runSandbox,
  SandboxFailure,
  staticPolicy,
  type SandboxBackend,
} from "../src/index";

const backend = (impl: SandboxBackend["run"]): SandboxBackend => ({ run: impl });
const allowToolAdmitter = () => Effect.succeed({ ok: true as const });
const toolAdmission = {
  authority: "execute",
  admit: allowToolAdmitter,
};

describe("@agent-os/sandbox v0 contract", () => {
  it.effect("runs one bounded stateless command", () =>
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
  );

  it.effect("policy denial is typed PolicyDenied", () =>
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
      ).pipe(Effect.result);

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("agent_os.sandbox_policy_denied");
        expect(result.failure.reason).toBe("network is disabled");
      }
    }),
  );

  it.effect("allowlist policy rejects hosts outside the allowed set", () =>
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
      ).pipe(Effect.result);

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("agent_os.sandbox_policy_denied");
        expect(result.failure.reason).toContain("blocked.com");
      }
    }),
  );

  it.effect("times out when the backend does not complete before timeoutMs", () =>
    Effect.gen(function* () {
      const fiber = yield* runSandbox(
        backend(() => Effect.never),
        staticPolicy(),
        { command: "sleep", timeoutMs: 10 },
      ).pipe(Effect.result, Effect.forkChild);
      yield* TestClock.adjust("11 millis");
      const result = yield* Fiber.join(fiber);

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure" && result.failure._tag === "agent_os.sandbox_failure") {
        expect(result.failure.code).toBe("Timeout");
        expect(result.failure.reason).toContain("10ms");
      }
    }),
  );

  it.effect("provider eviction is typed SandboxEvicted", () =>
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
      ).pipe(Effect.result);

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure" && result.failure._tag === "agent_os.sandbox_failure") {
        expect(result.failure.code).toBe("SandboxEvicted");
        expect(result.failure.sandboxId).toBe("sbx-dead");
      }
    }),
  );

  it.effect("tool helper byte-caps stdout and preserves explicit truncation facts", () =>
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
        ...toolAdmission,
        maxOutputBytes: 8,
      });

      const result = yield* tool.execute({ command: "make big-output" }, { materials: {} });

      expect(result.ok).toBe(true);
      expect(result.stdoutBytes).toBe(20);
      expect(result.stdoutHead).toBe("x".repeat(8));
      expect(result.stdoutTruncated).toBe(true);
      expect(result.stderrBytes).toBe(5);
      expect(result.stderrTruncated).toBe(false);
      expect(result.artifacts).toEqual([]);
    }),
  );

  it.effect("tool helper returns one fresh run result per invocation", () =>
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
        ...toolAdmission,
      });

      const first = yield* tool.execute({ command: "pwd" }, { materials: {} });
      const second = yield* tool.execute({ command: "pwd" }, { materials: {} });

      expect(first.sandboxId).toBe("sbx-1");
      expect(second.sandboxId).toBe("sbx-2");
    }),
  );

  it("tool helper rejects invalid args before execution", () => {
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
            sandboxId: "sbx-unreachable",
          };
        }),
      ),
      policy: staticPolicy(),
      ...toolAdmission,
    });

    expect(() => tool.decode({ args: ["missing-command"] })).toThrow("$.command:missing");
    expect(calls).toBe(0);
  });
});
