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

export interface CloudflareWorkspaceSessionClient {
  readonly id: string;
  readonly workspaceRootRef: string;
  readonly cleanupRef: string;
  readonly backup: (request: WorkspaceSessionBackupRequest) => Promise<{ readonly id: string }>;
  readonly preview: (
    request: WorkspaceSessionPreviewRequest,
  ) => Promise<{ readonly id: string; readonly url?: string }>;
  readonly destroy: (request: WorkspaceSessionDestroyRequest) => Promise<{ readonly id: string }>;
}

export interface CloudflareWorkspaceSessionNamespace {
  readonly start: (
    request: WorkspaceSessionStartRequest,
  ) => Promise<CloudflareWorkspaceSessionClient>;
  readonly restore: (
    request: WorkspaceSessionRestoreRequest,
  ) => Promise<CloudflareWorkspaceSessionClient>;
  readonly get: (sessionRef: string) => Promise<CloudflareWorkspaceSessionClient>;
}

export interface CloudflareWorkspaceSessionStartResult {
  readonly sessionRef: string;
  readonly workspaceRootRef: string;
  readonly cleanupRef: string;
}

export interface CloudflareWorkspaceSessionRestoreResult {
  readonly sessionRef: string;
  readonly workspaceRootRef: string;
  readonly cleanupRef: string;
}

export interface CloudflareWorkspaceSessionBackupResult {
  readonly backupRef?: string;
}

export interface CloudflareWorkspaceSessionPreviewResult {
  readonly previewRef?: string;
  readonly url?: string;
}

export interface CloudflareWorkspaceSessionDestroyResult {
  readonly proofRef: string;
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

export interface CloudflareWorkspaceSessionLiveProviderOptions {
  readonly namespace: CloudflareWorkspaceSessionNamespace;
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
    return typeof message === "string" ? message : "provider failure";
  }
  return typeof cause === "string" ? cause : "provider failure";
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

const requiredString = (result: Record<string, unknown>, key: string): string | undefined =>
  typeof result[key] === "string" && result[key].length > 0 ? result[key] : undefined;

const clientMethod = <K extends "backup" | "preview" | "destroy">(
  client: CloudflareWorkspaceSessionClient,
  key: K,
): CloudflareWorkspaceSessionClient[K] | null => {
  const method = client[key];
  if (typeof method !== "function") {
    return null;
  }
  return method;
};

const missingClientMethod = (key: "backup" | "preview" | "destroy"): Promise<never> =>
  Promise.reject({
    code: "ProviderFailure",
    reason: `Cloudflare workspace session client missing ${key}`,
  } satisfies CloudflareWorkspaceSessionProviderFailure);

export const makeCloudflareWorkspaceSessionProvider = (
  options: CloudflareWorkspaceSessionLiveProviderOptions,
): CloudflareWorkspaceSessionProvider => ({
  start: async (request) => {
    const client = await options.namespace.start(request);
    return {
      sessionRef: client.id,
      workspaceRootRef: client.workspaceRootRef,
      cleanupRef: client.cleanupRef,
    };
  },
  restore: async (request) => {
    const client = await options.namespace.restore(request);
    return {
      sessionRef: client.id,
      workspaceRootRef: client.workspaceRootRef,
      cleanupRef: client.cleanupRef,
    };
  },
  backup: async (request) => {
    const client = await options.namespace.get(request.sessionRef);
    const backup = clientMethod(client, "backup");
    if (backup === null) return missingClientMethod("backup");
    return { backupRef: (await backup(request)).id };
  },
  preview: async (request) => {
    const client = await options.namespace.get(request.sessionRef);
    const preview = clientMethod(client, "preview");
    if (preview === null) return missingClientMethod("preview");
    const result = await preview(request);
    return { previewRef: result.id, ...(result.url === undefined ? {} : { url: result.url }) };
  },
  destroy: async (request) => {
    const client = await options.namespace.get(request.sessionRef);
    const destroy = clientMethod(client, "destroy");
    if (destroy === null) return missingClientMethod("destroy");
    return { proofRef: (await destroy(request)).id };
  },
});

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
        const sessionRef = requiredString(
          result as unknown as Record<string, unknown>,
          "sessionRef",
        );
        const workspaceRootRef = requiredString(
          result as unknown as Record<string, unknown>,
          "workspaceRootRef",
        );
        const cleanupRef = requiredString(
          result as unknown as Record<string, unknown>,
          "cleanupRef",
        );
        if (
          sessionRef === undefined ||
          workspaceRootRef === undefined ||
          cleanupRef === undefined
        ) {
          return yield* Effect.fail(
            providerFailure(
              request.claim,
              "start",
              "ProviderFailure",
              "Cloudflare workspace session start missing required refs",
            ),
          );
        }
        return {
          subjectRef: request.subjectRef,
          sessionRef,
          workspaceRootRef,
          cleanupRef,
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
        const sessionRef = requiredString(
          result as unknown as Record<string, unknown>,
          "sessionRef",
        );
        const workspaceRootRef = requiredString(
          result as unknown as Record<string, unknown>,
          "workspaceRootRef",
        );
        const cleanupRef = requiredString(
          result as unknown as Record<string, unknown>,
          "cleanupRef",
        );
        if (
          sessionRef === undefined ||
          workspaceRootRef === undefined ||
          cleanupRef === undefined
        ) {
          return yield* Effect.fail(
            providerFailure(
              request.claim,
              "restore",
              "ProviderFailure",
              "Cloudflare workspace session restore missing required refs",
            ),
          );
        }
        return {
          subjectRef: request.subjectRef,
          sessionRef,
          backupRef: request.backupRef,
          workspaceRootRef,
          cleanupRef,
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
          return yield* Effect.fail(
            providerFailure(
              request.claim,
              "backup",
              "ProviderFailure",
              "Cloudflare workspace session backup missing backupRef",
            ),
          );
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
          return yield* Effect.fail(
            providerFailure(
              request.claim,
              "preview",
              "ProviderFailure",
              "Cloudflare workspace session preview missing previewRef",
            ),
          );
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
        const proofRef = requiredString(result as unknown as Record<string, unknown>, "proofRef");
        if (proofRef === undefined) {
          return yield* Effect.fail(
            providerFailure(
              request.claim,
              "destroy",
              "ProviderFailure",
              "Cloudflare workspace session destroy missing proofRef",
            ),
          );
        }
        return {
          subjectRef: request.subjectRef,
          sessionRef: request.sessionRef,
          reason: request.reason,
          claim: settleLivedClaim(request.claim, {
            anchorId: proofRef,
            anchorKind: "carrier_proof",
            carrierRef,
          }),
        };
      }),
  };
};
