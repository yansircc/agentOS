import { Clock, Effect, Option } from "effect";
import { defineToolFromDefinition, type Tool } from "@agent-os/kernel/tools";

import { failureToToolResult, truncateUtf8 } from "./output";
import { runSandbox } from "./run";
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  type MakeSandboxRunToolOptions,
  type SandboxRunRequest,
  type SandboxRunToolArgs,
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
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          text: { type: "string" },
        },
        required: ["path", "text"],
      },
    },
  },
  required: ["command"],
};

const failSandboxToolArgs = (message: string): never =>
  Option.getOrThrowWith(Option.none(), () => new TypeError(message));

const requestFromToolArgs = (
  input: SandboxRunToolArgs,
  defaults: Required<Pick<MakeSandboxRunToolOptions, "timeoutMs" | "maxOutputBytes" | "network">>,
): SandboxRunRequest => {
  const files =
    input.files === undefined
      ? undefined
      : Object.fromEntries(
          input.files.map((file) => {
            if (file.path.length === 0) {
              return failSandboxToolArgs("sandbox file path must be non-empty");
            }
            return [file.path, file.text];
          }),
        );
  if (files !== undefined && Object.keys(files).length !== input.files?.length) {
    return failSandboxToolArgs("sandbox file paths must be unique");
  }
  return {
    command: input.command,
    ...(input.args === undefined ? {} : { args: input.args }),
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(files === undefined ? {} : { files }),
    timeoutMs: defaults.timeoutMs,
    maxOutputBytes: defaults.maxOutputBytes,
    network: defaults.network,
  };
};

export const makeSandboxRunTool = (
  options: MakeSandboxRunToolOptions,
): Tool<SandboxRunToolArgs, SandboxToolResult> => {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const network = options.network ?? { mode: "none" as const };
  return defineToolFromDefinition<SandboxRunToolArgs, SandboxToolResult>({
    definition: {
      type: "function",
      function: {
        name: options.name ?? "sandbox_run",
        description:
          options.description ?? "Run one bounded stateless command in an isolated sandbox.",
        parameters: toolParameters,
      },
    },
    decode: (args) => args as SandboxRunToolArgs,
    authorityClass: options.authority,
    ...(options.authorityId === undefined ? {} : { authorityId: options.authorityId }),
    ...(options.authorityVersion === undefined
      ? {}
      : { authorityVersion: options.authorityVersion }),
    admit: options.admit,
    execute: (args) => {
      const request = requestFromToolArgs(args, { timeoutMs, maxOutputBytes, network });
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
  });
};
