import { Clock, Effect } from "effect";

import { failureToToolResult, truncateUtf8 } from "./output";
import { runSandbox } from "./run";
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  type MakeSandboxRunToolOptions,
  type SandboxRunRequest,
  type SandboxToolLike,
  type SandboxToolResult,
} from "./types";

const toolParameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    command: { type: "string" },
    args: { type: "array", items: { type: "string" } },
    cwd: { type: "string" },
    files: {
      type: "object",
      additionalProperties: { type: "string" },
    },
  },
  required: ["command"],
};

const coerceToolArgs = (
  value: unknown,
  defaults: Required<Pick<MakeSandboxRunToolOptions, "timeoutMs" | "maxOutputBytes" | "network">>,
): SandboxRunRequest => {
  const input =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const command = typeof input.command === "string" ? input.command : "";
  const args = Array.isArray(input.args)
    ? input.args.filter((arg): arg is string => typeof arg === "string")
    : undefined;
  const cwd = typeof input.cwd === "string" ? input.cwd : undefined;
  const rawFiles =
    typeof input.files === "object" && input.files !== null && !Array.isArray(input.files)
      ? (input.files as Record<string, unknown>)
      : undefined;
  const files =
    rawFiles === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(rawFiles).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        );
  return {
    command,
    args,
    cwd,
    files,
    timeoutMs: defaults.timeoutMs,
    maxOutputBytes: defaults.maxOutputBytes,
    network: defaults.network,
  };
};

export const makeSandboxRunTool = (options: MakeSandboxRunToolOptions): SandboxToolLike => {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const network = options.network ?? { mode: "none" as const };
  return {
    definition: {
      type: "function",
      function: {
        name: options.name ?? "sandbox_run",
        description:
          options.description ?? "Run one bounded stateless command in an isolated sandbox.",
        parameters: toolParameters,
      },
    },
    execute: (args) => {
      const request = coerceToolArgs(args, { timeoutMs, maxOutputBytes, network });
      const program = Effect.gen(function* () {
        const started = yield* Clock.currentTimeMillis;
        const result = yield* runSandbox(options.backend, options.policy, request).pipe(
          Effect.either,
        );
        const ended = yield* Clock.currentTimeMillis;
        if (result._tag === "Left") {
          return failureToToolResult(result.left, ended - started, maxOutputBytes);
        }
        const stdout = truncateUtf8(result.right.stdout, maxOutputBytes);
        const stderr = truncateUtf8(result.right.stderr, maxOutputBytes);
        return {
          ok: true,
          exitCode: result.right.exitCode,
          stdoutHead: stdout.head,
          stderrHead: stderr.head,
          stdoutBytes: stdout.bytes,
          stderrBytes: stderr.bytes,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
          artifacts: [],
          durationMs: result.right.durationMs,
          sandboxId: result.right.sandboxId,
        } satisfies SandboxToolResult;
      });
      return Effect.runPromise(program); // eff-ignore EFF400 reason="Tool.execute is the public Promise adapter for this library; not a process runMain edge"
    },
  };
};
