/**
 * Cloudflare Sandbox SDK-compatible backend.
 *
 * This package intentionally uses structural types instead of importing
 * `@cloudflare/sandbox`: the SDK object is supplied by the Worker/app
 * environment, while this adapter owns normalization into the
 * provider-neutral @agent-os/sandbox algebra.
 */

import { Effect } from "effect";
import {
  type SandboxBackend,
  SandboxFailure,
  type SandboxFileContent,
  type SandboxRawResult,
  type SandboxRunRequest,
} from "@agent-os/sandbox";

export interface CloudflareSandboxExecOptions {
  readonly args?: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

export interface CloudflareSandboxExecResult {
  readonly exitCode?: number;
  readonly code?: number;
  readonly stdout?: unknown;
  readonly stderr?: unknown;
  readonly output?: unknown;
  readonly success?: boolean;
}

export interface CloudflareSandboxClient {
  readonly id?: string;
  readonly exec: (
    command: string,
    options?: CloudflareSandboxExecOptions,
  ) => Promise<CloudflareSandboxExecResult>;
  readonly writeFile?: (
    path: string,
    content: string | Uint8Array,
  ) => Promise<unknown>;
}

export interface CloudflareSandboxBackendOptions {
  readonly getSandbox: (
    request: SandboxRunRequest,
  ) => CloudflareSandboxClient | Promise<CloudflareSandboxClient>;
  readonly sandboxId?: (
    client: CloudflareSandboxClient,
    request: SandboxRunRequest,
  ) => string;
}

const fileContent = (content: SandboxFileContent): string | Uint8Array => {
  if (typeof content === "string" || content instanceof Uint8Array) {
    return content;
  }
  if ("bytes" in content) {
    return content.bytes;
  }
  return content.text;
};

const messageOf = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "object" && cause !== null && "message" in cause) {
    return String((cause as { readonly message: unknown }).message);
  }
  return String(cause);
};

const classifyCloudflareFailure = (
  cause: unknown,
  sandboxId?: string,
): SandboxFailure => {
  const reason = messageOf(cause);
  const lower = reason.toLowerCase();
  if (
    lower.includes("evict") ||
    lower.includes("destroy") ||
    lower.includes("not found") ||
    lower.includes("404")
  ) {
    return new SandboxFailure({
      code: "SandboxEvicted",
      reason,
      sandboxId,
    });
  }
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return new SandboxFailure({ code: "Timeout", reason, sandboxId });
  }
  if (lower.includes("oom") || lower.includes("out of memory")) {
    return new SandboxFailure({ code: "OOM", reason, sandboxId });
  }
  if (
    lower.includes("network") ||
    lower.includes("egress") ||
    lower.includes("blocked")
  ) {
    return new SandboxFailure({ code: "NetworkBlocked", reason, sandboxId });
  }
  return new SandboxFailure({ code: "ProviderFailure", reason, sandboxId });
};

const normalizeExecResult = (
  raw: CloudflareSandboxExecResult,
  sandboxId: string,
): SandboxRawResult => {
  const exitCode =
    raw.exitCode ??
    raw.code ??
    (raw.success === undefined ? 0 : raw.success ? 0 : 1);
  const stdout =
    raw.stdout === undefined
      ? raw.output === undefined
        ? ""
        : String(raw.output)
      : String(raw.stdout);
  const stderr = raw.stderr === undefined ? "" : String(raw.stderr);
  return { exitCode, stdout, stderr, artifacts: [], sandboxId };
};

export const makeCloudflareSandboxBackend = (
  options: CloudflareSandboxBackendOptions,
): SandboxBackend => ({
  run: (request) =>
    Effect.gen(function* () {
      const client = yield* Effect.tryPromise({
        try: () => Promise.resolve(options.getSandbox(request)),
        catch: (cause: unknown): SandboxFailure =>
          classifyCloudflareFailure(cause),
      });
      const sandboxId =
        options.sandboxId?.(client, request) ?? client.id ?? "cloudflare";

      for (const [path, content] of Object.entries(request.files ?? {})) {
        const writeFile = client.writeFile;
        if (writeFile === undefined) {
          return yield* Effect.fail(
            new SandboxFailure({
              code: "ProviderFailure",
              reason: "Cloudflare sandbox client does not expose writeFile",
              sandboxId,
            }),
          );
        }
        yield* Effect.tryPromise({
          try: () => writeFile(path, fileContent(content)),
          catch: (cause: unknown): SandboxFailure =>
            classifyCloudflareFailure(cause, sandboxId),
        });
      }

      const raw = yield* Effect.tryPromise({
        try: () =>
          client.exec(request.command, {
            args: request.args,
            cwd: request.cwd,
            timeoutMs: request.timeoutMs,
          }),
        catch: (cause: unknown): SandboxFailure =>
          classifyCloudflareFailure(cause, sandboxId),
      });
      return normalizeExecResult(raw, sandboxId);
    }),
});
