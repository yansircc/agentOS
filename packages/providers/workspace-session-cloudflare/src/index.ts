import { Effect } from "effect";
import { settleLivedClaim, type PreClaim } from "@agent-os/kernel/effect-claim";
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

type CloudflareWorkspaceSessionRequiredProviderFailure =
  CloudflareWorkspaceSessionProviderFailure & {
    readonly code: WorkspaceSessionFailure["code"];
    readonly reason: string;
  };

type WorkspaceSessionProviderRequest =
  | WorkspaceSessionStartRequest
  | WorkspaceSessionRestoreRequest
  | WorkspaceSessionBackupRequest
  | WorkspaceSessionPreviewRequest
  | WorkspaceSessionDestroyRequest;

export interface CloudflareWorkspaceSandboxOptions {
  readonly sleepAfter?: string;
  readonly keepAlive?: boolean;
  readonly containerTimeouts?: unknown;
  readonly normalizeId?: boolean;
}

export interface CloudflareWorkspaceSandboxNamespace {
  readonly [key: string]: unknown;
}

export interface CloudflareWorkspaceSandboxSessionOptions {
  readonly id: string;
  readonly cwd: string;
}

export interface CloudflareWorkspaceSandboxBackupOptions {
  readonly dir: string;
  readonly name?: string;
  readonly ttl?: number;
  readonly useGitignore?: boolean;
  readonly localBucket?: boolean;
}

export interface CloudflareWorkspaceSandboxBackupHandle {
  readonly id?: string;
  readonly dir?: string;
}

export interface CloudflareWorkspaceSandboxRestoreResult {
  readonly success?: boolean;
  readonly id?: string;
  readonly dir?: string;
}

export interface CloudflareWorkspaceSandboxExposePortOptions {
  readonly hostname: string;
  readonly name?: string;
  readonly token?: string;
}

export interface CloudflareWorkspaceSandboxExposePortResult {
  readonly port?: number;
  readonly url?: string;
  readonly name?: string;
}

export interface CloudflareWorkspaceSandboxClient {
  readonly createSession?: (options: CloudflareWorkspaceSandboxSessionOptions) => Promise<unknown>;
  readonly createBackup?: (
    options: CloudflareWorkspaceSandboxBackupOptions,
  ) => Promise<CloudflareWorkspaceSandboxBackupHandle>;
  readonly restoreBackup?: (
    backup: Required<CloudflareWorkspaceSandboxBackupHandle>,
  ) => Promise<CloudflareWorkspaceSandboxRestoreResult>;
  readonly exposePort?: (
    port: number,
    options: CloudflareWorkspaceSandboxExposePortOptions,
  ) => Promise<CloudflareWorkspaceSandboxExposePortResult>;
  readonly destroy?: () => Promise<unknown>;
}

export type CloudflareWorkspaceSandboxFactory = (
  binding: CloudflareWorkspaceSandboxNamespace,
  sandboxId: string,
  options?: CloudflareWorkspaceSandboxOptions,
) => CloudflareWorkspaceSandboxClient | Promise<CloudflareWorkspaceSandboxClient>;

export type CloudflareWorkspaceSandboxSource =
  | {
      readonly kind: "namespace";
      readonly binding: CloudflareWorkspaceSandboxNamespace;
      readonly getSandbox: CloudflareWorkspaceSandboxFactory;
      readonly sandboxOptions?: CloudflareWorkspaceSandboxOptions;
    }
  | {
      readonly kind: "client";
      readonly getClient: (spec: {
        readonly request: WorkspaceSessionProviderRequest;
        readonly sandboxId: string;
      }) => CloudflareWorkspaceSandboxClient | Promise<CloudflareWorkspaceSandboxClient>;
    };

export interface CloudflareWorkspaceSessionBackupOptions {
  readonly name?: string | ((request: WorkspaceSessionBackupRequest) => string | undefined);
  readonly ttl?: number | ((request: WorkspaceSessionBackupRequest) => number | undefined);
  readonly useGitignore?:
    | boolean
    | ((request: WorkspaceSessionBackupRequest) => boolean | undefined);
  readonly localBucket?:
    | boolean
    | ((request: WorkspaceSessionBackupRequest) => boolean | undefined);
}

export interface CloudflareWorkspaceSessionPreviewOptions {
  readonly hostname: string | ((request: WorkspaceSessionPreviewRequest) => string);
  readonly name?: string | ((request: WorkspaceSessionPreviewRequest) => string | undefined);
  readonly token?: string | ((request: WorkspaceSessionPreviewRequest) => string | undefined);
}

export interface CloudflareWorkspaceSessionSandboxProviderOptions {
  readonly source: CloudflareWorkspaceSandboxSource;
  readonly sandboxId: (
    request: WorkspaceSessionStartRequest | WorkspaceSessionRestoreRequest,
  ) => string;
  readonly sessionId: (
    request: WorkspaceSessionStartRequest | WorkspaceSessionRestoreRequest,
  ) => string;
  readonly workspaceDir: string;
  readonly backup?: CloudflareWorkspaceSessionBackupOptions;
  readonly preview?: CloudflareWorkspaceSessionPreviewOptions;
}

const DEFAULT_CARRIER_REF = "cloudflare-sandbox";
const SESSION_REF_PREFIX = "cloudflare-sandbox-session:";
const WORKSPACE_ROOT_REF_PREFIX = "cloudflare-sandbox-workspace:";
const BACKUP_REF_PREFIX = "cloudflare-sandbox-backup:";
const PREVIEW_REF_PREFIX = "cloudflare-sandbox-preview:";
const CLEANUP_REF_PREFIX = "cloudflare-sandbox-cleanup:";
const DESTROY_PROOF_REF_PREFIX = "cloudflare-sandbox-destroy:";

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

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

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

const providerRejected = <A>(
  reason: string,
  code: WorkspaceSessionFailure["code"] = "ProviderFailure",
): Promise<A> =>
  Promise.reject({
    code,
    reason,
  } satisfies CloudflareWorkspaceSessionProviderFailure);

const encodedRef = (prefix: string, parts: ReadonlyArray<string>): string =>
  `${prefix}${parts.map((part) => encodeURIComponent(part)).join(":")}`;

const decodedRef = (
  ref: string,
  prefix: string,
  partCount: number,
  step: WorkspaceSessionFailure["step"],
):
  | { readonly ok: true; readonly parts: ReadonlyArray<string> }
  | { readonly ok: false; readonly failure: CloudflareWorkspaceSessionRequiredProviderFailure } => {
  if (!ref.startsWith(prefix)) {
    return {
      ok: false,
      failure: {
        code: "ProviderFailure",
        reason: `Cloudflare workspace session ${step} ref is not owned by this carrier`,
      },
    };
  }
  const rawParts = ref.slice(prefix.length).split(":");
  if (rawParts.length !== partCount || rawParts.some((part) => part.length === 0)) {
    return {
      ok: false,
      failure: {
        code: "ProviderFailure",
        reason: `Cloudflare workspace session ${step} ref is malformed`,
      },
    };
  }
  return {
    ok: true,
    parts: rawParts.map((part) => decodeURIComponent(part)),
  };
};

const sessionRefOf = (sandboxId: string, sessionId: string): string =>
  encodedRef(SESSION_REF_PREFIX, [sandboxId, sessionId]);

const workspaceRootRefOf = (sandboxId: string, sessionId: string, workspaceDir: string): string =>
  encodedRef(WORKSPACE_ROOT_REF_PREFIX, [sandboxId, sessionId, workspaceDir]);

const cleanupRefOf = (sandboxId: string): string => encodedRef(CLEANUP_REF_PREFIX, [sandboxId]);

const backupRefOf = (id: string, dir: string): string => encodedRef(BACKUP_REF_PREFIX, [id, dir]);

const parseBackupRef = (
  backupRef: string,
  step: WorkspaceSessionFailure["step"],
):
  | Required<CloudflareWorkspaceSandboxBackupHandle>
  | CloudflareWorkspaceSessionRequiredProviderFailure => {
  const decoded = decodedRef(backupRef, BACKUP_REF_PREFIX, 2, step);
  if (!decoded.ok) return decoded.failure;
  const [id, dir] = decoded.parts;
  return { id: id!, dir: dir! };
};

const previewRefOf = (port: number, url: string): string =>
  encodedRef(PREVIEW_REF_PREFIX, [String(port), url]);

const destroyProofRefOf = (sessionRef: string): string =>
  encodedRef(DESTROY_PROOF_REF_PREFIX, [sessionRef]);

const parseSessionRef = (
  sessionRef: string,
  step: WorkspaceSessionFailure["step"],
):
  | { readonly sandboxId: string; readonly sessionId: string }
  | CloudflareWorkspaceSessionRequiredProviderFailure => {
  const decoded = decodedRef(sessionRef, SESSION_REF_PREFIX, 2, step);
  if (!decoded.ok) return decoded.failure;
  const [sandboxId, sessionId] = decoded.parts;
  return { sandboxId: sandboxId!, sessionId: sessionId! };
};

const requiredOptionString = (
  value: unknown,
  label: string,
  step: WorkspaceSessionFailure["step"],
): string | CloudflareWorkspaceSessionRequiredProviderFailure =>
  isNonEmptyString(value)
    ? value
    : {
        code: "ProviderFailure",
        reason: `Cloudflare workspace session ${step} requires ${label}`,
      };

const requiredOptionNumber = (
  value: unknown,
  label: string,
  step: WorkspaceSessionFailure["step"],
): number | CloudflareWorkspaceSessionRequiredProviderFailure =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : {
        code: "ProviderFailure",
        reason: `Cloudflare workspace session ${step} requires positive ${label}`,
      };

const isProviderFailure = (
  value: unknown,
): value is CloudflareWorkspaceSessionRequiredProviderFailure =>
  isRecord(value) &&
  providerFailureCode(value.code) !== undefined &&
  typeof value.reason === "string";

const requireClient = (
  value: CloudflareWorkspaceSandboxClient,
  step: WorkspaceSessionFailure["step"],
): CloudflareWorkspaceSandboxClient | CloudflareWorkspaceSessionRequiredProviderFailure =>
  isRecord(value)
    ? value
    : {
        code: "ProviderFailure",
        reason: `Cloudflare workspace session ${step} source did not return a sandbox client`,
      };

const sandboxClient = async (
  options: CloudflareWorkspaceSessionSandboxProviderOptions,
  request: WorkspaceSessionProviderRequest,
  sandboxId: string,
  step: WorkspaceSessionFailure["step"],
): Promise<CloudflareWorkspaceSandboxClient> => {
  const source = options.source;
  const value =
    source.kind === "namespace"
      ? await source.getSandbox(source.binding, sandboxId, source.sandboxOptions)
      : await source.getClient({ request, sandboxId });
  const client = requireClient(value, step);
  return isProviderFailure(client) ? providerRejected(client.reason, client.code) : client;
};

const requireMethod = <T extends (...args: never[]) => Promise<unknown>>(
  client: CloudflareWorkspaceSandboxClient,
  method: keyof CloudflareWorkspaceSandboxClient,
  step: WorkspaceSessionFailure["step"],
): T | CloudflareWorkspaceSessionRequiredProviderFailure => {
  const value = client[method];
  return typeof value === "function"
    ? (value as unknown as T)
    : {
        code: "ProviderFailure",
        reason: `Cloudflare Sandbox SDK method ${String(method)} is required for workspace-session ${step}`,
      };
};

const valueOrUndefined = <Request>(
  value: string | ((request: Request) => string | undefined) | undefined,
  request: Request,
): string | undefined => (typeof value === "function" ? value(request) : value);

const booleanOrUndefined = <Request>(
  value: boolean | ((request: Request) => boolean | undefined) | undefined,
  request: Request,
): boolean | undefined => (typeof value === "function" ? value(request) : value);

const numberOrUndefined = <Request>(
  value: number | ((request: Request) => number | undefined) | undefined,
  request: Request,
): number | undefined => (typeof value === "function" ? value(request) : value);

const backupOptions = (
  options: CloudflareWorkspaceSessionSandboxProviderOptions,
  request: WorkspaceSessionBackupRequest,
): CloudflareWorkspaceSandboxBackupOptions | CloudflareWorkspaceSessionRequiredProviderFailure => {
  const config = options.backup;
  const out: {
    dir: string;
    name?: string;
    ttl?: number;
    useGitignore?: boolean;
    localBucket?: boolean;
  } = { dir: options.workspaceDir };
  const name = valueOrUndefined(config?.name, request);
  const ttl = numberOrUndefined(config?.ttl, request);
  const useGitignore = booleanOrUndefined(config?.useGitignore, request);
  const localBucket = booleanOrUndefined(config?.localBucket, request);
  if (name !== undefined) out.name = name;
  if (ttl !== undefined) {
    const requiredTtl = requiredOptionNumber(ttl, "backup.ttl", "backup");
    if (isProviderFailure(requiredTtl)) return requiredTtl;
    out.ttl = requiredTtl;
  }
  if (useGitignore !== undefined) out.useGitignore = useGitignore;
  if (localBucket !== undefined) out.localBucket = localBucket;
  return out;
};

const previewOptions = (
  options: CloudflareWorkspaceSessionSandboxProviderOptions,
  request: WorkspaceSessionPreviewRequest,
):
  | CloudflareWorkspaceSandboxExposePortOptions
  | CloudflareWorkspaceSessionRequiredProviderFailure => {
  const config = options.preview;
  if (config === undefined) {
    return {
      code: "ProviderFailure",
      reason: "Cloudflare workspace session preview requires preview options",
    };
  }
  const hostname =
    typeof config.hostname === "function" ? config.hostname(request) : config.hostname;
  const requiredHostname = requiredOptionString(hostname, "preview.hostname", "preview");
  if (isProviderFailure(requiredHostname)) return requiredHostname;
  const name = valueOrUndefined(config.name, request);
  const token = valueOrUndefined(config.token, request);
  return {
    hostname: requiredHostname,
    ...(name === undefined ? {} : { name }),
    ...(token === undefined ? {} : { token }),
  };
};

const ensureSameString = (
  actual: string,
  expected: string,
  label: string,
  step: WorkspaceSessionFailure["step"],
): CloudflareWorkspaceSessionRequiredProviderFailure | null =>
  actual === expected
    ? null
    : {
        code: "ProviderFailure",
        reason: `Cloudflare workspace session ${step} returned ${label} that does not match the requested value`,
      };

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

export const makeCloudflareWorkspaceSessionLiveProvider = (
  options: CloudflareWorkspaceSessionSandboxProviderOptions,
): CloudflareWorkspaceSessionProvider => ({
  start: async (request) => {
    const sandboxId = requiredOptionString(options.sandboxId(request), "sandboxId", "start");
    if (isProviderFailure(sandboxId)) return providerRejected(sandboxId.reason, sandboxId.code);
    const sessionId = requiredOptionString(options.sessionId(request), "sessionId", "start");
    if (isProviderFailure(sessionId)) return providerRejected(sessionId.reason, sessionId.code);
    const workspaceDir = requiredOptionString(options.workspaceDir, "workspaceDir", "start");
    if (isProviderFailure(workspaceDir))
      return providerRejected(workspaceDir.reason, workspaceDir.code);
    const client = await sandboxClient(options, request, sandboxId, "start");
    const createSession = requireMethod<
      (sessionOptions: CloudflareWorkspaceSandboxSessionOptions) => Promise<unknown>
    >(client, "createSession", "start");
    if (isProviderFailure(createSession)) {
      return providerRejected(createSession.reason, createSession.code);
    }
    await createSession.call(client, { id: sessionId, cwd: workspaceDir });
    return {
      sessionRef: sessionRefOf(sandboxId, sessionId),
      workspaceRootRef: workspaceRootRefOf(sandboxId, sessionId, workspaceDir),
      cleanupRef: cleanupRefOf(sandboxId),
    };
  },

  restore: async (request) => {
    const backup = parseBackupRef(request.backupRef, "restore");
    if (isProviderFailure(backup)) return providerRejected(backup.reason, backup.code);
    const sandboxId = requiredOptionString(options.sandboxId(request), "sandboxId", "restore");
    if (isProviderFailure(sandboxId)) return providerRejected(sandboxId.reason, sandboxId.code);
    const sessionId = requiredOptionString(options.sessionId(request), "sessionId", "restore");
    if (isProviderFailure(sessionId)) return providerRejected(sessionId.reason, sessionId.code);
    const client = await sandboxClient(options, request, sandboxId, "restore");
    const restoreBackup = requireMethod<
      (
        backup: Required<CloudflareWorkspaceSandboxBackupHandle>,
      ) => Promise<CloudflareWorkspaceSandboxRestoreResult>
    >(client, "restoreBackup", "restore");
    if (isProviderFailure(restoreBackup)) {
      return providerRejected(restoreBackup.reason, restoreBackup.code);
    }
    const restored = await restoreBackup.call(client, backup);
    if (restored.success !== true) {
      return providerRejected("Cloudflare workspace session restoreBackup did not report success");
    }
    const restoredId = requiredOptionString(restored.id, "restoreBackup.id", "restore");
    if (isProviderFailure(restoredId)) return providerRejected(restoredId.reason, restoredId.code);
    const restoredDir = requiredOptionString(restored.dir, "restoreBackup.dir", "restore");
    if (isProviderFailure(restoredDir))
      return providerRejected(restoredDir.reason, restoredDir.code);
    const idMismatch = ensureSameString(restoredId, backup.id, "backup id", "restore");
    if (idMismatch !== null) return providerRejected(idMismatch.reason, idMismatch.code);
    const dirMismatch = ensureSameString(restoredDir, backup.dir, "backup dir", "restore");
    if (dirMismatch !== null) return providerRejected(dirMismatch.reason, dirMismatch.code);
    const createSession = requireMethod<
      (sessionOptions: CloudflareWorkspaceSandboxSessionOptions) => Promise<unknown>
    >(client, "createSession", "restore");
    if (isProviderFailure(createSession)) {
      return providerRejected(createSession.reason, createSession.code);
    }
    await createSession.call(client, { id: sessionId, cwd: restoredDir });
    return {
      sessionRef: sessionRefOf(sandboxId, sessionId),
      workspaceRootRef: workspaceRootRefOf(sandboxId, sessionId, restoredDir),
      cleanupRef: cleanupRefOf(sandboxId),
    };
  },

  backup: async (request) => {
    const parsed = parseSessionRef(request.sessionRef, "backup");
    if (isProviderFailure(parsed)) return providerRejected(parsed.reason, parsed.code);
    const client = await sandboxClient(options, request, parsed.sandboxId, "backup");
    const createBackup = requireMethod<
      (
        backupOptions: CloudflareWorkspaceSandboxBackupOptions,
      ) => Promise<CloudflareWorkspaceSandboxBackupHandle>
    >(client, "createBackup", "backup");
    if (isProviderFailure(createBackup)) {
      return providerRejected(createBackup.reason, createBackup.code);
    }
    const resolvedBackupOptions = backupOptions(options, request);
    if (isProviderFailure(resolvedBackupOptions)) {
      return providerRejected(resolvedBackupOptions.reason, resolvedBackupOptions.code);
    }
    const backup = await createBackup.call(client, resolvedBackupOptions);
    const backupId = requiredOptionString(backup.id, "createBackup.id", "backup");
    if (isProviderFailure(backupId)) return providerRejected(backupId.reason, backupId.code);
    const backupDir = requiredOptionString(backup.dir, "createBackup.dir", "backup");
    if (isProviderFailure(backupDir)) return providerRejected(backupDir.reason, backupDir.code);
    const dirMismatch = ensureSameString(backupDir, options.workspaceDir, "backup dir", "backup");
    if (dirMismatch !== null) return providerRejected(dirMismatch.reason, dirMismatch.code);
    return { backupRef: backupRefOf(backupId, backupDir) };
  },

  preview: async (request) => {
    const parsed = parseSessionRef(request.sessionRef, "preview");
    if (isProviderFailure(parsed)) return providerRejected(parsed.reason, parsed.code);
    const client = await sandboxClient(options, request, parsed.sandboxId, "preview");
    const exposePort = requireMethod<
      (
        port: number,
        options: CloudflareWorkspaceSandboxExposePortOptions,
      ) => Promise<CloudflareWorkspaceSandboxExposePortResult>
    >(client, "exposePort", "preview");
    if (isProviderFailure(exposePort)) return providerRejected(exposePort.reason, exposePort.code);
    const resolvedPreviewOptions = previewOptions(options, request);
    if (isProviderFailure(resolvedPreviewOptions)) {
      return providerRejected(resolvedPreviewOptions.reason, resolvedPreviewOptions.code);
    }
    const exposed = await exposePort.call(client, request.port, resolvedPreviewOptions);
    if (exposed.port !== request.port) {
      return providerRejected("Cloudflare workspace session exposePort returned a different port");
    }
    const url = requiredOptionString(exposed.url, "exposePort.url", "preview");
    if (isProviderFailure(url)) return providerRejected(url.reason, url.code);
    return {
      previewRef: previewRefOf(request.port, url),
      url,
    };
  },

  destroy: async (request) => {
    const parsed = parseSessionRef(request.sessionRef, "destroy");
    if (isProviderFailure(parsed)) return providerRejected(parsed.reason, parsed.code);
    const client = await sandboxClient(options, request, parsed.sandboxId, "destroy");
    const destroy = requireMethod<() => Promise<unknown>>(client, "destroy", "destroy");
    if (isProviderFailure(destroy)) return providerRejected(destroy.reason, destroy.code);
    await destroy.call(client);
    return { proofRef: destroyProofRefOf(request.sessionRef) };
  },
});
