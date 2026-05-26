/**
 * Provider-neutral sandbox algebra.
 *
 * v0 is bounded, stateless, synchronous exec. A sandbox run is a carrier
 * operation behind a normal agentOS Tool; it is not durable state and it does
 * not write the ledger.
 */

import { Clock, Data, Duration, Effect } from "effect";

export const SANDBOX_MAX_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 16_384;

export type SandboxFailureCode =
  | "SandboxEvicted"
  | "PolicyDenied"
  | "Timeout"
  | "OOM"
  | "NetworkBlocked"
  | "ProviderFailure";

export type SandboxNetwork =
  | { readonly mode: "none" }
  | { readonly mode: "allowlist"; readonly hosts: ReadonlyArray<string> };

export type SandboxFileContent =
  | string
  | Uint8Array
  | { readonly bytes: Uint8Array; readonly executable?: boolean }
  | { readonly text: string; readonly executable?: boolean };

export interface SandboxRunRequest {
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly files?: Readonly<Record<string, SandboxFileContent>>;
  readonly timeoutMs: number;
  readonly maxOutputBytes?: number;
  readonly network?: SandboxNetwork;
}

export type ArtifactSource =
  | {
      readonly kind: "url";
      readonly url: string;
      readonly contentType?: string;
      readonly name?: string;
    }
  | {
      readonly kind: "data";
      readonly bytes: Uint8Array;
      readonly contentType: string;
      readonly name?: string;
    }
  | {
      readonly kind: "stream";
      readonly stream: ReadableStream<Uint8Array>;
      readonly contentType?: string;
      readonly name?: string;
    };

export interface ArtifactRef {
  readonly ref: string;
  readonly contentType?: string;
  readonly name?: string;
  readonly bytes?: number;
  readonly digest?: string;
}

export interface SandboxRawResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly artifacts?: ReadonlyArray<ArtifactSource>;
  readonly sandboxId: string;
}

export interface SandboxRunSuccess extends SandboxRawResult {
  readonly durationMs: number;
}

export interface SandboxResultFields {
  readonly exitCode?: number;
  readonly stdoutHead: string;
  readonly stderrHead: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly artifacts: ReadonlyArray<ArtifactRef>;
  readonly durationMs: number;
  readonly sandboxId: string;
}

export type SandboxToolResult =
  | (SandboxResultFields & { readonly ok: true; readonly exitCode: number })
  | (SandboxResultFields & {
      readonly ok: false;
      readonly failureCode: SandboxFailureCode;
      readonly reason: string;
    });

export class SandboxFailure extends Data.TaggedError(
  "agent_os.sandbox_failure",
)<{
  readonly code: SandboxFailureCode;
  readonly reason: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly sandboxId?: string;
}> {}

export class SandboxPolicyDenied extends Data.TaggedError(
  "agent_os.sandbox_policy_denied",
)<{
  readonly reason: string;
}> {}

export interface SandboxPolicyRequest {
  readonly request: SandboxRunRequest;
}

export type SandboxPolicy = (
  request: SandboxPolicyRequest,
) => Effect.Effect<void, SandboxPolicyDenied>;

export interface StaticPolicyOptions {
  readonly allowNetwork?: false | ReadonlyArray<string>;
  readonly maxTimeoutMs?: number;
}

export interface SandboxBackend {
  readonly run: (
    request: SandboxRunRequest,
  ) => Effect.Effect<SandboxRawResult, SandboxFailure>;
}

export interface SandboxToolDefinition {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: object;
  };
}

export interface SandboxToolLike {
  readonly definition: SandboxToolDefinition;
  readonly execute: (args: unknown) => Promise<SandboxToolResult>;
}

export interface MakeSandboxRunToolOptions {
  readonly backend: SandboxBackend;
  readonly policy: SandboxPolicy;
  readonly name?: string;
  readonly description?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly network?: SandboxNetwork;
}

const byteLength = (text: string): number => new TextEncoder().encode(text).length;

const truncateUtf8 = (
  text: string,
  maxBytes: number,
): { readonly head: string; readonly bytes: number; readonly truncated: boolean } => {
  const encoded = new TextEncoder().encode(text);
  if (encoded.length <= maxBytes) {
    return { head: text, bytes: encoded.length, truncated: false };
  }
  const head = new TextDecoder().decode(encoded.slice(0, maxBytes));
  return { head, bytes: encoded.length, truncated: true };
};

const reasonText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const validateRequest = (
  request: SandboxRunRequest,
): Effect.Effect<void, SandboxPolicyDenied> =>
  Effect.gen(function* () {
    // Tool callers need one closed failure channel; malformed requests surface
    // as PolicyDenied rather than expanding the tool result error algebra.
    if (request.command.trim().length === 0) {
      return yield* new SandboxPolicyDenied({ reason: "command must be non-empty" });
    }
    if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) {
      return yield* new SandboxPolicyDenied({ reason: "timeoutMs must be positive" });
    }
    if (request.timeoutMs > SANDBOX_MAX_TIMEOUT_MS) {
      return yield* new SandboxPolicyDenied({
        reason: `timeoutMs exceeds ${SANDBOX_MAX_TIMEOUT_MS}`,
      });
    }
    const maxOutputBytes = request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    if (!Number.isFinite(maxOutputBytes) || maxOutputBytes <= 0) {
      return yield* new SandboxPolicyDenied({
        reason: "maxOutputBytes must be positive",
      });
    }
  });

export const staticPolicy = (
  options: StaticPolicyOptions = {},
): SandboxPolicy =>
  ({ request }) =>
    Effect.gen(function* () {
      const maxTimeoutMs = options.maxTimeoutMs ?? SANDBOX_MAX_TIMEOUT_MS;
      if (request.timeoutMs > maxTimeoutMs) {
        return yield* new SandboxPolicyDenied({
          reason: `timeoutMs exceeds policy cap ${maxTimeoutMs}`,
        });
      }
      const requestedNetwork = request.network ?? { mode: "none" as const };
      const allowNetwork = options.allowNetwork ?? false;
      if (requestedNetwork.mode === "none") {
        return;
      }
      if (allowNetwork === false) {
        return yield* new SandboxPolicyDenied({ reason: "network is disabled" });
      }
      const allowed = new Set(allowNetwork);
      const blocked = requestedNetwork.hosts.filter((host) => !allowed.has(host));
      if (blocked.length > 0) {
        return yield* new SandboxPolicyDenied({
          reason: `network host not allowed: ${blocked.join(",")}`,
        });
      }
    });

export const toSandboxToolResult = (
  result: SandboxRunSuccess,
  artifactRefs: ReadonlyArray<ArtifactRef> = [],
): SandboxToolResult => {
  const maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES;
  const stdout = truncateUtf8(result.stdout, maxOutputBytes);
  const stderr = truncateUtf8(result.stderr, maxOutputBytes);
  return {
    ok: true,
    exitCode: result.exitCode,
    stdoutHead: stdout.head,
    stderrHead: stderr.head,
    stdoutBytes: stdout.bytes,
    stderrBytes: stderr.bytes,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    artifacts: artifactRefs,
    durationMs: result.durationMs,
    sandboxId: result.sandboxId,
  };
};

const failureToToolResult = (
  failure: SandboxFailure | SandboxPolicyDenied,
  durationMs: number,
  maxOutputBytes: number,
): SandboxToolResult => {
  const isPolicy = failure._tag === "agent_os.sandbox_policy_denied";
  const stdout = truncateUtf8(isPolicy ? "" : failure.stdout ?? "", maxOutputBytes);
  const stderr = truncateUtf8(isPolicy ? "" : failure.stderr ?? "", maxOutputBytes);
  return {
    ok: false,
    failureCode: isPolicy ? "PolicyDenied" : failure.code,
    reason: failure.reason,
    stdoutHead: stdout.head,
    stderrHead: stderr.head,
    stdoutBytes: stdout.bytes,
    stderrBytes: stderr.bytes,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    artifacts: [],
    durationMs,
    sandboxId: isPolicy ? "policy" : failure.sandboxId ?? "unknown",
  };
};

export const runSandbox = (
  backend: SandboxBackend,
  policy: SandboxPolicy,
  request: SandboxRunRequest,
): Effect.Effect<SandboxRunSuccess, SandboxFailure | SandboxPolicyDenied> =>
  Effect.gen(function* () {
    yield* validateRequest(request);
    yield* policy({ request });
    const started = yield* Clock.currentTimeMillis;
    const result = yield* backend.run(request).pipe(
      Effect.timeoutFail({
        duration: Duration.millis(request.timeoutMs),
        onTimeout: () =>
          new SandboxFailure({
            code: "Timeout",
            reason: `sandbox run exceeded ${request.timeoutMs}ms`,
          }),
      }),
    );
    const ended = yield* Clock.currentTimeMillis;
    return { ...result, durationMs: ended - started };
  });

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
  defaults: Required<
    Pick<MakeSandboxRunToolOptions, "timeoutMs" | "maxOutputBytes" | "network">
  >,
): SandboxRunRequest => {
  const input =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
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

export const makeSandboxRunTool = (
  options: MakeSandboxRunToolOptions,
): SandboxToolLike => {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const network = options.network ?? { mode: "none" as const };
  return {
    definition: {
      type: "function",
      function: {
        name: options.name ?? "sandbox_run",
        description:
          options.description ??
          "Run one bounded stateless command in an isolated sandbox.",
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

export const sandboxFailureFromUnknown = (
  cause: unknown,
  fallbackCode: SandboxFailureCode = "ProviderFailure",
): SandboxFailure => {
  const reason = reasonText(cause);
  return new SandboxFailure({ code: fallbackCode, reason });
};

export const measureOutputBytes = byteLength;
