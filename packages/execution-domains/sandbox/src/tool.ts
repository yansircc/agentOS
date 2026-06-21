import { Clock, Effect, Option, Schema } from "effect";
import { ToolError } from "@agent-os/kernel/errors";
import {
  defineTool,
  externalToolExecution,
  withToolWriteRequirement,
  type Tool,
} from "@agent-os/kernel/tools";

import { failureToToolResult, truncateUtf8 } from "./output";
import { runSandbox } from "./run";
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  type MakeSandboxRunToolOptions,
  type SandboxRunRequest,
  type SandboxRunToolArgs,
  type SandboxToolResult,
} from "./types";

const SandboxRunToolArgsSchema: Schema.Decoder<SandboxRunToolArgs> = Schema.Struct({
  command: Schema.String,
  args: Schema.optional(Schema.Array(Schema.String)),
  cwd: Schema.optional(Schema.String),
  files: Schema.optional(
    Schema.Array(
      Schema.Struct({
        path: Schema.String,
        text: Schema.String,
      }),
    ),
  ),
});

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
  return defineTool({
    name: options.name ?? "sandbox_run",
    description: options.description ?? "Run one bounded stateless command in an isolated sandbox.",
    args: SandboxRunToolArgsSchema,
    authority: options.authority,
    ...(options.authorityId === undefined ? {} : { authorityId: options.authorityId }),
    ...(options.authorityVersion === undefined
      ? {}
      : { authorityVersion: options.authorityVersion }),
    admit: options.admit,
    execution: externalToolExecution("write", {
      kind: "sandbox",
      ref: options.authorityId ?? options.name ?? "sandbox_run",
    }),
    execute: (args) =>
      withToolWriteRequirement(
        Effect.withSpan("agentos.sandbox.tool.execute")(
          Effect.gen(function* () {
            const request = yield* Effect.try({
              try: () => requestFromToolArgs(args, { timeoutMs, maxOutputBytes, network }),
              catch: (cause) => new ToolError({ toolName: options.name ?? "sandbox_run", cause }),
            });
            const started = yield* Clock.currentTimeMillis;
            const result = yield* runSandbox(options.backend, options.policy, request).pipe(
              Effect.result,
            );
            const ended = yield* Clock.currentTimeMillis;
            if (result._tag === "Failure") {
              return failureToToolResult(result.failure, ended - started, maxOutputBytes);
            }
            const stdout = truncateUtf8(result.success.stdout, maxOutputBytes);
            const stderr = truncateUtf8(result.success.stderr, maxOutputBytes);
            return {
              ok: true,
              exitCode: result.success.exitCode,
              stdoutHead: stdout.head,
              stderrHead: stderr.head,
              stdoutBytes: stdout.bytes,
              stderrBytes: stderr.bytes,
              stdoutTruncated: stdout.truncated,
              stderrTruncated: stderr.truncated,
              artifacts: [],
              durationMs: result.success.durationMs,
              sandboxId: result.success.sandboxId,
            } satisfies SandboxToolResult;
          }),
        ),
      ),
  });
};
