import { Option } from "effect";
import type { PreClaim } from "@agent-os/kernel/effect-claim";
import {
  rejectWorkspaceOperation,
  settleWorkspaceOperationCompleted,
  type WorkspaceOperationCompletedPayload,
  type WorkspaceOperationRequestedPayload,
  type WorkspaceOperationRejectedPayload,
  type WorkspaceOperationToolResult,
  workspaceOperationToolResult,
} from "@agent-os/workspace-op";
import {
  editWorkspaceFile,
  normalizeWorkspaceToolPath,
  type WorkspaceEnv,
  type WorkspaceExecResult,
} from "@agent-os/workspace-env";

export interface WorkspaceOperationRequestEvent {
  readonly id: number;
  readonly payload: WorkspaceOperationRequestedPayload;
}

export type WorkspaceOperationLocalProviderResult =
  | {
      readonly ok: true;
      readonly payload: WorkspaceOperationCompletedPayload;
      readonly result: WorkspaceOperationToolResult;
    }
  | {
      readonly ok: false;
      readonly payload: WorkspaceOperationRejectedPayload;
    };

export interface WorkspaceOperationLocalProvider {
  readonly execute: (
    event: WorkspaceOperationRequestEvent,
  ) => Promise<WorkspaceOperationLocalProviderResult>;
}

export interface CreateWorkspaceOperationLocalProviderOptions {
  readonly env: WorkspaceEnv;
  readonly maxFileBytes?: number;
  readonly maxCommandChars?: number;
  readonly execTimeoutMs?: number;
  readonly maxOutputBytes?: number;
}

const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
const DEFAULT_MAX_COMMAND_CHARS = 2_000;
const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 16_384;

const textEncoder = new TextEncoder();

const failWorkspaceOperationLocalProvider = (message: string): never =>
  Option.getOrThrowWith(Option.none(), () => new TypeError(message));

const sha256Hex = (value: string): Promise<string> => {
  const subtle = typeof crypto === "undefined" ? undefined : crypto.subtle;
  if (subtle === undefined) {
    return failWorkspaceOperationLocalProvider("Web Crypto subtle digest is required");
  }
  return subtle.digest("SHA-256", textEncoder.encode(value)).then((digest) =>
    Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join(""),
  );
};

const stableJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
};

const hashJson = (value: unknown): Promise<string> => sha256Hex(stableJson(value));

const utf8Bytes = (value: string): number => textEncoder.encode(value).byteLength;

const truncateUtf8 = (
  value: string,
  maxBytes: number,
): { readonly text: string; readonly bytes: number; readonly truncated: boolean } => {
  let text = "";
  let bytes = 0;
  for (const char of value) {
    const charBytes = utf8Bytes(char);
    if (bytes + charBytes > maxBytes) {
      return { text, bytes: utf8Bytes(value), truncated: true };
    }
    text += char;
    bytes += charBytes;
  }
  return { text, bytes, truncated: false };
};

const requirePath = (request: WorkspaceOperationRequestedPayload): string => {
  if (request.path === undefined || request.path.length === 0) {
    return failWorkspaceOperationLocalProvider(`${request.toolName} requires path`);
  }
  return normalizeWorkspaceToolPath(request.path);
};

const requireString = (
  request: WorkspaceOperationRequestedPayload,
  key: "content" | "oldString" | "newString" | "command",
): string => {
  const value = request[key];
  if (value === undefined || value.length === 0) {
    return failWorkspaceOperationLocalProvider(`${request.toolName} requires ${key}`);
  }
  return value;
};

const positiveNumberOr = (value: number | undefined, fallback: number): number =>
  Number.isFinite(value) && value !== undefined && value > 0 ? value : fallback;

const operationRef = (claim: PreClaim): string => claim.operationRef;

const completedPayload = (
  request: WorkspaceOperationRequestedPayload,
  requestedEventId: number,
  result: Omit<WorkspaceOperationCompletedPayload, "claim">,
): WorkspaceOperationCompletedPayload => ({
  ...result,
  claim: settleWorkspaceOperationCompleted(request.claim, {
    requestedEventId,
    idempotencyKey: operationRef(request.claim),
  }),
});

const rejectedPayload = (
  request: WorkspaceOperationRequestedPayload,
  requestedEventId: number,
  reason: string,
): WorkspaceOperationRejectedPayload => ({
  requestedEventId,
  operationRef: operationRef(request.claim),
  workspaceRef: request.workspaceRef,
  toolName: request.toolName,
  idempotencyKey: operationRef(request.claim),
  reason,
  ...(request.toolCallId === undefined ? {} : { toolCallId: request.toolCallId }),
  claim: rejectWorkspaceOperation(request.claim, {
    requestedEventId,
    idempotencyKey: operationRef(request.claim),
  }),
});

const boundedShellResult = async (
  request: WorkspaceOperationRequestedPayload,
  requestedEventId: number,
  command: string,
  cwd: string,
  result: WorkspaceExecResult,
  maxOutputBytes: number,
): Promise<WorkspaceOperationCompletedPayload> => {
  const stdout = truncateUtf8(result.stdout, maxOutputBytes);
  const stderr = truncateUtf8(result.stderr, maxOutputBytes);
  const stdoutHash = await sha256Hex(result.stdout);
  const stderrHash = await sha256Hex(result.stderr);
  const publicResult = {
    kind: "run_shell" as const,
    command,
    cwd,
    exitCode: result.exitCode,
    stdoutPreview: stdout.text,
    stderrPreview: stderr.text,
    stdoutBytes: stdout.bytes,
    stderrBytes: stderr.bytes,
    stdoutTruncated: result.stdoutTruncated || stdout.truncated,
    stderrTruncated: result.stderrTruncated || stderr.truncated,
    stdoutHash,
    stderrHash,
    durationMs: result.durationMs,
  };
  return completedPayload(request, requestedEventId, {
    requestedEventId,
    operationRef: operationRef(request.claim),
    workspaceRef: request.workspaceRef,
    toolName: "run_shell",
    idempotencyKey: operationRef(request.claim),
    resultHash: await hashJson(publicResult),
    ...(request.toolCallId === undefined ? {} : { toolCallId: request.toolCallId }),
    command,
    cwd,
    exitCode: result.exitCode,
    stdoutPreview: stdout.text,
    stderrPreview: stderr.text,
    stdoutBytes: stdout.bytes,
    stderrBytes: stderr.bytes,
    stdoutTruncated: result.stdoutTruncated || stdout.truncated,
    stderrTruncated: result.stderrTruncated || stderr.truncated,
    stdoutHash,
    stderrHash,
    durationMs: result.durationMs,
  });
};

export const createWorkspaceOperationLocalProvider = (
  options: CreateWorkspaceOperationLocalProviderOptions,
): WorkspaceOperationLocalProvider => {
  const completedByIdempotencyKey = new Map<string, WorkspaceOperationLocalProviderResult>();
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxCommandChars = options.maxCommandChars ?? DEFAULT_MAX_COMMAND_CHARS;
  const execTimeoutMs = options.execTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  return {
    execute: async (event) => {
      const request = event.payload;
      const idempotencyKey = operationRef(request.claim);
      const previous = completedByIdempotencyKey.get(idempotencyKey);
      if (previous !== undefined) return previous;

      try {
        let completed: WorkspaceOperationCompletedPayload;
        switch (request.toolName) {
          case "write_file": {
            const path = requirePath(request);
            const content = requireString(request, "content");
            const bytes = utf8Bytes(content);
            if (bytes > maxFileBytes) {
              failWorkspaceOperationLocalProvider(`file exceeds ${maxFileBytes} bytes`);
            }
            await options.env.writeFile(path, content);
            const publicResult = {
              kind: "write_file" as const,
              path,
              bytesWritten: bytes,
            };
            completed = completedPayload(request, event.id, {
              requestedEventId: event.id,
              operationRef: idempotencyKey,
              workspaceRef: request.workspaceRef,
              toolName: "write_file",
              idempotencyKey,
              resultHash: await hashJson(publicResult),
              ...(request.toolCallId === undefined ? {} : { toolCallId: request.toolCallId }),
              path,
              bytesWritten: bytes,
            });
            break;
          }
          case "edit_file": {
            const path = requirePath(request);
            const oldString = requireString(request, "oldString");
            const newString = request.newString ?? "";
            const result = await editWorkspaceFile(options.env, {
              path,
              oldString,
              newString,
              expectCount: request.expectCount,
              maxFileBytes,
            });
            const publicResult = {
              kind: "edit_file" as const,
              path: result.path,
              replacementCount: result.replacementCount,
              bytesWritten: result.bytesWritten,
            };
            completed = completedPayload(request, event.id, {
              requestedEventId: event.id,
              operationRef: idempotencyKey,
              workspaceRef: request.workspaceRef,
              toolName: "edit_file",
              idempotencyKey,
              resultHash: await hashJson(publicResult),
              ...(request.toolCallId === undefined ? {} : { toolCallId: request.toolCallId }),
              path: result.path,
              replacementCount: result.replacementCount,
              bytesWritten: result.bytesWritten,
            });
            break;
          }
          case "delete_path": {
            const path = requirePath(request);
            await options.env.rm(path, {
              recursive: request.recursive ?? false,
              force: request.force ?? false,
            });
            const publicResult = {
              kind: "delete_path" as const,
              path,
              deleted: true,
            };
            completed = completedPayload(request, event.id, {
              requestedEventId: event.id,
              operationRef: idempotencyKey,
              workspaceRef: request.workspaceRef,
              toolName: "delete_path",
              idempotencyKey,
              resultHash: await hashJson(publicResult),
              ...(request.toolCallId === undefined ? {} : { toolCallId: request.toolCallId }),
              path,
              deleted: true,
            });
            break;
          }
          case "run_shell": {
            const command = requireString(request, "command").trim();
            if (command.length === 0) {
              failWorkspaceOperationLocalProvider("command required");
            }
            if (command.length > maxCommandChars) {
              failWorkspaceOperationLocalProvider(`command exceeds ${maxCommandChars} characters`);
            }
            const cwd =
              request.cwd === undefined
                ? "."
                : normalizeWorkspaceToolPath(request.cwd, { allowRoot: true });
            const result = await options.env.exec(command, {
              cwd,
              timeoutMs: positiveNumberOr(request.timeoutMs, execTimeoutMs),
              maxOutputBytes,
              envRefs:
                request.envRefs === undefined
                  ? undefined
                  : Object.fromEntries(request.envRefs.map((entry) => [entry.name, entry.ref])),
              materialRefs: request.materialRefs,
            });
            completed = await boundedShellResult(
              request,
              event.id,
              command,
              cwd,
              result,
              maxOutputBytes,
            );
            break;
          }
        }
        const ok = {
          ok: true as const,
          payload: completed,
          result: workspaceOperationToolResult(completed),
        };
        completedByIdempotencyKey.set(idempotencyKey, ok);
        return ok;
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        const failed = { ok: false as const, payload: rejectedPayload(request, event.id, reason) };
        completedByIdempotencyKey.set(idempotencyKey, failed);
        return failed;
      }
    },
  };
};
