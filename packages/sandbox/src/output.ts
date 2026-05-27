import {
  DEFAULT_MAX_OUTPUT_BYTES,
  SandboxFailure,
  type ArtifactRef,
  type SandboxFailureCode,
  type SandboxRunSuccess,
  type SandboxToolResult,
  SandboxPolicyDenied,
} from "./types";

const byteLength = (text: string): number => new TextEncoder().encode(text).length;

export const truncateUtf8 = (
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

export const failureToToolResult = (
  failure: SandboxFailure | SandboxPolicyDenied,
  durationMs: number,
  maxOutputBytes: number,
): SandboxToolResult => {
  const isPolicy = failure._tag === "agent_os.sandbox_policy_denied";
  const stdout = truncateUtf8(isPolicy ? "" : (failure.stdout ?? ""), maxOutputBytes);
  const stderr = truncateUtf8(isPolicy ? "" : (failure.stderr ?? ""), maxOutputBytes);
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
    sandboxId: isPolicy ? "policy" : (failure.sandboxId ?? "unknown"),
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
