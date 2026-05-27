import { Effect } from "effect";
import { settleLivedClaim, type PreClaim } from "@agent-os/core/effect-claim";
import {
  resolveWorkspaceSession,
  settleWorkspaceSessionRejected,
  type WorkspaceSessionBackupRequest,
  type WorkspaceSessionCarrier,
  type WorkspaceSessionDestroyRequest,
  type WorkspaceSessionFailure,
  type WorkspaceSessionPreviewRequest,
  type WorkspaceSessionRestoreRequest,
  type WorkspaceSessionStartRequest,
} from "@agent-os/workspace-session";

export interface CloudflareWorkspaceSessionStartResult {
  readonly sessionRef?: string;
  readonly workspaceRootRef?: string;
  readonly cleanupRef?: string;
}

export interface CloudflareWorkspaceSessionRestoreResult {
  readonly sessionRef?: string;
  readonly workspaceRootRef?: string;
  readonly cleanupRef?: string;
}

export interface CloudflareWorkspaceSessionBackupResult {
  readonly backupRef?: string;
}

export interface CloudflareWorkspaceSessionPreviewResult {
  readonly previewRef?: string;
  readonly url?: string;
}

export interface CloudflareWorkspaceSessionDestroyResult {
  readonly proofRef?: string;
}

export interface CloudflareWorkspaceSessionProvider {
  readonly start: (
    request: WorkspaceSessionStartRequest,
  ) => Promise<CloudflareWorkspaceSessionStartResult>;
  readonly restore: (
    request: WorkspaceSessionRestoreRequest,
  ) => Promise<CloudflareWorkspaceSessionRestoreResult>;
  readonly backup: (
    request: WorkspaceSessionBackupRequest,
  ) => Promise<CloudflareWorkspaceSessionBackupResult>;
  readonly preview: (
    request: WorkspaceSessionPreviewRequest,
  ) => Promise<CloudflareWorkspaceSessionPreviewResult>;
  readonly destroy: (
    request: WorkspaceSessionDestroyRequest,
  ) => Promise<CloudflareWorkspaceSessionDestroyResult>;
}

export interface CloudflareWorkspaceSessionCarrierOptions {
  readonly provider: CloudflareWorkspaceSessionProvider;
  readonly carrierRef?: string;
}

export interface CloudflareWorkspaceSessionProviderFailure {
  readonly code?: WorkspaceSessionFailure["code"];
  readonly reason?: string;
  readonly proofRef?: string;
}

const DEFAULT_CARRIER_REF = "cloudflare-sandbox";

const messageOf = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "object" && cause !== null && "message" in cause) {
    const message = (cause as { readonly message: unknown }).message;
    return typeof message === "string" ? message : JSON.stringify(message);
  }
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
};

const providerFailure = (
  claim: PreClaim,
  step: WorkspaceSessionFailure["step"],
  code: WorkspaceSessionFailure["code"],
  reason: string,
  proofRef?: string,
): WorkspaceSessionFailure => ({
  code,
  step,
  reason,
  claim: settleWorkspaceSessionRejected(claim, {
    code,
    reason,
    ...(proofRef === undefined ? {} : { proofRef }),
  }),
  ...(proofRef === undefined ? {} : { proofRef }),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const providerFailureCode = (value: unknown): WorkspaceSessionFailure["code"] | undefined =>
  value === "ScopeNotSession" ||
  value === "PolicyDenied" ||
  value === "StartFailed" ||
  value === "RestoreFailed" ||
  value === "BackupFailed" ||
  value === "PreviewFailed" ||
  value === "DestroyFailed" ||
  value === "ProviderFailure"
    ? value
    : undefined;

const defaultFailureCode = (
  step: WorkspaceSessionFailure["step"],
): WorkspaceSessionFailure["code"] =>
  step === "start"
    ? "StartFailed"
    : step === "restore"
      ? "RestoreFailed"
      : step === "backup"
        ? "BackupFailed"
        : step === "preview"
          ? "PreviewFailed"
          : "DestroyFailed";

const failureFrom = (
  claim: PreClaim,
  step: WorkspaceSessionFailure["step"],
  cause: unknown,
): WorkspaceSessionFailure => {
  if (isRecord(cause)) {
    const code = providerFailureCode(cause.code);
    const reason = typeof cause.reason === "string" ? cause.reason : messageOf(cause);
    const proofRef = typeof cause.proofRef === "string" ? cause.proofRef : undefined;
    if (code !== undefined) {
      return providerFailure(claim, step, code, reason, proofRef);
    }
  }
  return providerFailure(claim, step, defaultFailureCode(step), messageOf(cause));
};

const sessionResolution = (
  claim: PreClaim,
  carrierRef: string,
): ReturnType<typeof resolveWorkspaceSession> =>
  resolveWorkspaceSession(claim.scopeRef, { carrierRef });

const scopeFailure = (
  claim: PreClaim,
  step: WorkspaceSessionFailure["step"],
): WorkspaceSessionFailure =>
  providerFailure(claim, step, "ScopeNotSession", "workspace session claim scope is not session");

const requiredRef = (
  claim: PreClaim,
  step: WorkspaceSessionFailure["step"],
  label: string,
): WorkspaceSessionFailure =>
  providerFailure(claim, step, "ProviderFailure", `Cloudflare workspace session missing ${label}`);

export const makeCloudflareWorkspaceSessionCarrier = (
  options: CloudflareWorkspaceSessionCarrierOptions,
): WorkspaceSessionCarrier => {
  const carrierRef = options.carrierRef ?? DEFAULT_CARRIER_REF;

  return {
    start: (request) =>
      Effect.gen(function* () {
        const resolution = sessionResolution(request.claim, carrierRef);
        if (!resolution.ok) {
          return yield* Effect.fail(scopeFailure(request.claim, "start"));
        }
        const result = yield* Effect.tryPromise({
          try: () => options.provider.start(request),
          catch: (cause): WorkspaceSessionFailure => failureFrom(request.claim, "start", cause),
        });
        const sessionRef = result.sessionRef ?? resolution.sessionRootRef;
        return {
          subjectRef: request.subjectRef,
          sessionRef,
          workspaceRootRef: result.workspaceRootRef ?? resolution.workspaceRootRef,
          cleanupRef: result.cleanupRef ?? resolution.cleanupRef,
          ...(request.retention === undefined ? {} : { retention: request.retention }),
          claim: settleLivedClaim(request.claim, {
            anchorId: sessionRef,
            anchorKind: "carrier_proof",
            carrierRef,
          }),
        };
      }),

    restore: (request) =>
      Effect.gen(function* () {
        const resolution = sessionResolution(request.claim, carrierRef);
        if (!resolution.ok) {
          return yield* Effect.fail(scopeFailure(request.claim, "restore"));
        }
        const result = yield* Effect.tryPromise({
          try: () => options.provider.restore(request),
          catch: (cause): WorkspaceSessionFailure => failureFrom(request.claim, "restore", cause),
        });
        const sessionRef = result.sessionRef ?? resolution.sessionRootRef;
        return {
          subjectRef: request.subjectRef,
          sessionRef,
          backupRef: request.backupRef,
          workspaceRootRef: result.workspaceRootRef ?? resolution.workspaceRootRef,
          cleanupRef: result.cleanupRef ?? resolution.cleanupRef,
          ...(request.retention === undefined ? {} : { retention: request.retention }),
          claim: settleLivedClaim(request.claim, {
            anchorId: sessionRef,
            anchorKind: "carrier_proof",
            carrierRef,
          }),
        };
      }),

    backup: (request) =>
      Effect.gen(function* () {
        const result = yield* Effect.tryPromise({
          try: () => options.provider.backup(request),
          catch: (cause): WorkspaceSessionFailure => failureFrom(request.claim, "backup", cause),
        });
        if (result.backupRef === undefined) {
          return yield* Effect.fail(requiredRef(request.claim, "backup", "backupRef"));
        }
        return {
          subjectRef: request.subjectRef,
          sessionRef: request.sessionRef,
          backupRef: result.backupRef,
          ...(request.expiresAt === undefined ? {} : { expiresAt: request.expiresAt }),
          claim: settleLivedClaim(request.claim, {
            anchorId: result.backupRef,
            anchorKind: "carrier_proof",
            carrierRef,
          }),
        };
      }),

    allocatePreview: (request) =>
      Effect.gen(function* () {
        const result = yield* Effect.tryPromise({
          try: () => options.provider.preview(request),
          catch: (cause): WorkspaceSessionFailure => failureFrom(request.claim, "preview", cause),
        });
        if (result.previewRef === undefined) {
          return yield* Effect.fail(requiredRef(request.claim, "preview", "previewRef"));
        }
        return {
          subjectRef: request.subjectRef,
          sessionRef: request.sessionRef,
          previewRef: result.previewRef,
          port: request.port,
          ...(result.url === undefined ? {} : { url: result.url }),
          claim: settleLivedClaim(request.claim, {
            anchorId: result.previewRef,
            anchorKind: "carrier_proof",
            carrierRef,
          }),
        };
      }),

    destroy: (request) =>
      Effect.gen(function* () {
        const result = yield* Effect.tryPromise({
          try: () => options.provider.destroy(request),
          catch: (cause): WorkspaceSessionFailure => failureFrom(request.claim, "destroy", cause),
        });
        return {
          subjectRef: request.subjectRef,
          sessionRef: request.sessionRef,
          reason: request.reason,
          claim: settleLivedClaim(request.claim, {
            anchorId: result.proofRef ?? request.sessionRef,
            anchorKind: "carrier_proof",
            carrierRef,
          }),
        };
      }),
  };
};
