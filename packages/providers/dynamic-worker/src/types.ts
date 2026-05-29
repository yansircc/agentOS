import { Data, Effect } from "effect";
import type { LivedClaim, PreClaim, RejectedClaim } from "@agent-os/kernel/effect-claim";
import type { RuntimeScopeResolution } from "@agent-os/kernel/runtime-scope";

export const DYNAMIC_WORKER_MAX_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_BODY_BYTES = 16_384;

export type DynamicWorkerEgress =
  | { readonly mode: "none" }
  | { readonly mode: "allowlist"; readonly hosts: ReadonlyArray<string> };

export type DynamicWorkerBinding =
  | {
      readonly kind: "json";
      readonly name: string;
      readonly value: unknown;
    }
  | {
      readonly kind: "text";
      readonly name: string;
      readonly value: string;
    }
  | {
      readonly kind: "service";
      readonly name: string;
      readonly serviceRef: string;
    };

export interface DynamicWorkerHttpRequest {
  readonly method?: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array;
}

export interface DynamicWorkerLimits {
  readonly cpuMs?: number;
  readonly subrequests?: number;
}

export interface DynamicWorkerRunRequest {
  readonly claim: PreClaim;
  readonly code: string;
  readonly codeRef?: string;
  readonly compatibilityDate?: string;
  readonly request: DynamicWorkerHttpRequest;
  readonly bindings?: ReadonlyArray<DynamicWorkerBinding>;
  readonly egress?: DynamicWorkerEgress;
  readonly limits?: DynamicWorkerLimits;
  readonly timeoutMs: number;
  readonly maxBodyBytes?: number;
}

export type DynamicWorkerFailureCode =
  | "PolicyDenied"
  | "Timeout"
  | "CompileError"
  | "RuntimeError"
  | "ResourceLimitExceeded"
  | "NetworkBlocked"
  | "ProviderFailure";

export interface DynamicWorkerRawResult {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body: string;
  readonly workerId: string;
  readonly metrics?: Readonly<Record<string, unknown>>;
}

export interface DynamicWorkerRunSuccess extends DynamicWorkerRawResult {
  readonly durationMs: number;
  readonly claim: LivedClaim;
}

export class DynamicWorkerFailure extends Data.TaggedError("agent_os.dynamic_worker_failure")<{
  readonly code: Exclude<DynamicWorkerFailureCode, "PolicyDenied">;
  readonly reason: string;
  readonly status?: number;
  readonly workerId?: string;
  readonly claim: RejectedClaim;
}> {}

export class DynamicWorkerProviderFailure extends Data.TaggedError(
  "agent_os.dynamic_worker_provider_failure",
)<{
  readonly code: Exclude<DynamicWorkerFailureCode, "PolicyDenied">;
  readonly reason: string;
  readonly status?: number;
  readonly body?: string;
  readonly workerId?: string;
}> {}

export class DynamicWorkerPolicyViolation extends Data.TaggedError(
  "agent_os.dynamic_worker_policy_violation",
)<{
  readonly reason: string;
}> {}

export class DynamicWorkerPolicyDenied extends Data.TaggedError(
  "agent_os.dynamic_worker_policy_denied",
)<{
  readonly reason: string;
  readonly claim: RejectedClaim;
}> {}

export interface DynamicWorkerPolicyRequest {
  readonly request: DynamicWorkerRunRequest;
  readonly runtimeScope?: RuntimeScopeResolution;
}

export type DynamicWorkerPolicy = (
  request: DynamicWorkerPolicyRequest,
) => Effect.Effect<void, DynamicWorkerPolicyViolation>;

export interface DynamicWorkerStaticPolicyOptions {
  readonly allowEgress?: false | ReadonlyArray<string>;
  readonly maxTimeoutMs?: number;
  readonly maxCodeBytes?: number;
  readonly maxBodyBytes?: number;
}

export interface DynamicWorkerBackend {
  readonly run: (
    request: DynamicWorkerRunRequest,
  ) => Effect.Effect<DynamicWorkerRawResult, DynamicWorkerProviderFailure>;
}
