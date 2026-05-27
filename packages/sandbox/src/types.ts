import { Data, Effect } from "effect";

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

export class SandboxFailure extends Data.TaggedError("agent_os.sandbox_failure")<{
  readonly code: SandboxFailureCode;
  readonly reason: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly sandboxId?: string;
}> {}

export class SandboxPolicyDenied extends Data.TaggedError("agent_os.sandbox_policy_denied")<{
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
  readonly run: (request: SandboxRunRequest) => Effect.Effect<SandboxRawResult, SandboxFailure>;
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
