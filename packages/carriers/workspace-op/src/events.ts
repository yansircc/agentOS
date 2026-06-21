import { Predicate } from "effect";
import type { LivedClaim, PreClaim, RejectedClaim } from "@agent-os/core/effect-claim";
import { validateEffectClaim } from "@agent-os/core/effect-claim";
import { validateTerminalClaim } from "@agent-os/core/settlement-contract";
import {
  WORKSPACE_OP_EVENTS,
  WORKSPACE_OP_KIND,
  workspaceOpSettlementContract,
} from "./definition";
export {
  WORKSPACE_OP_EVENTS,
  WORKSPACE_OP_FACT_OWNER,
  WORKSPACE_OP_KIND,
  WORKSPACE_OP_PROJECTION_KIND,
} from "./definition";

type WorkspaceOpPayloads = typeof WORKSPACE_OP_EVENTS;

export type WorkspaceOperationRequestedPayload =
  WorkspaceOpPayloads[(typeof WORKSPACE_OP_KIND)["REQUESTED"]];
export type WorkspaceOperationCompletedPayload =
  WorkspaceOpPayloads[(typeof WORKSPACE_OP_KIND)["COMPLETED"]];
export type WorkspaceOperationRejectedPayload =
  WorkspaceOpPayloads[(typeof WORKSPACE_OP_KIND)["REJECTED"]];

export type WorkspaceOperationName = WorkspaceOperationRequestedPayload["toolName"];

export interface WorkspaceOperationLedgerEvent {
  readonly id: number;
  readonly kind: string;
  readonly payload: unknown;
}

export type WorkspaceOperationProjection =
  | {
      readonly status: "missing";
      readonly requestedEventId: number;
    }
  | {
      readonly status: "requested";
      readonly requestedEventId: number;
      readonly request: WorkspaceOperationRequestedPayload;
    }
  | {
      readonly status: "completed";
      readonly requestedEventId: number;
      readonly request: WorkspaceOperationRequestedPayload;
      readonly completed: WorkspaceOperationCompletedPayload;
      readonly result: WorkspaceOperationToolResult;
    }
  | {
      readonly status: "rejected";
      readonly requestedEventId: number;
      readonly request: WorkspaceOperationRequestedPayload;
      readonly rejected: WorkspaceOperationRejectedPayload;
    };

export type WorkspaceOperationToolResult =
  | {
      readonly kind: "write_file";
      readonly path: string;
      readonly bytesWritten: number;
      readonly resultHash: string;
    }
  | {
      readonly kind: "bash";
      readonly command: string;
      readonly cwd: string;
      readonly exitCode: number;
      readonly stdoutPreview: string;
      readonly stderrPreview: string;
      readonly stdoutBytes: number;
      readonly stderrBytes: number;
      readonly stdoutTruncated: boolean;
      readonly stderrTruncated: boolean;
      readonly stdoutHash: string;
      readonly stderrHash: string;
      readonly durationMs: number;
      readonly resultHash: string;
    };

const preClaimFrom = (value: unknown): PreClaim | undefined => {
  const result = validateEffectClaim(value);
  return result.ok && result.claim.phase === "pre" ? result.claim : undefined;
};

const livedClaimFrom = (value: unknown): LivedClaim | undefined => {
  const result = validateTerminalClaim(workspaceOpSettlementContract, value);
  return result.ok && result.claim.phase === "lived" ? result.claim : undefined;
};

const rejectedClaimFrom = (value: unknown): RejectedClaim | undefined => {
  const result = validateTerminalClaim(workspaceOpSettlementContract, value);
  return result.ok && result.claim.phase === "rejected" ? result.claim : undefined;
};

const stringField = (payload: Record<string, unknown>, key: string): string | undefined =>
  typeof payload[key] === "string" ? payload[key] : undefined;

const numberField = (payload: Record<string, unknown>, key: string): number | undefined =>
  typeof payload[key] === "number" && Number.isFinite(payload[key])
    ? (payload[key] as number)
    : undefined;

const stringArrayField = (
  payload: Record<string, unknown>,
  key: string,
): ReadonlyArray<string> | undefined => {
  const value = payload[key];
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((item): item is string => typeof item === "string" && item.length > 0);
  return out.length === value.length ? out : undefined;
};

const envRefsField = (
  payload: Record<string, unknown>,
): NonNullable<WorkspaceOperationRequestedPayload["envRefs"]> | undefined => {
  const value = payload.envRefs;
  if (!Array.isArray(value)) return undefined;
  const out = value.flatMap((item) => {
    if (!Predicate.isObject(item)) return [];
    const name = typeof item.name === "string" && item.name.length > 0 ? item.name : undefined;
    const ref = typeof item.ref === "string" && item.ref.length > 0 ? item.ref : undefined;
    return name === undefined || ref === undefined ? [] : [{ name, ref }];
  });
  return out.length === value.length ? out : undefined;
};

const operationNameFrom = (value: unknown): WorkspaceOperationName | undefined =>
  value === "write_file" || value === "bash" ? value : undefined;

const requestFrom = (
  id: number,
  payload: Record<string, unknown>,
): WorkspaceOperationRequestedPayload | undefined => {
  const requestedBy = stringField(payload, "requestedBy");
  const workspaceRef = stringField(payload, "workspaceRef");
  const toolCallId = stringField(payload, "toolCallId");
  const toolName = operationNameFrom(payload.toolName);
  const claim = preClaimFrom(payload.claim);
  if (
    requestedBy === undefined ||
    workspaceRef === undefined ||
    toolName === undefined ||
    claim === undefined
  ) {
    return undefined;
  }
  return {
    requestedBy,
    workspaceRef,
    toolName,
    ...(toolCallId === undefined ? {} : { toolCallId }),
    ...(stringField(payload, "path") === undefined ? {} : { path: stringField(payload, "path") }),
    ...(stringField(payload, "content") === undefined
      ? {}
      : { content: stringField(payload, "content") }),
    ...(stringField(payload, "command") === undefined
      ? {}
      : { command: stringField(payload, "command") }),
    ...(stringField(payload, "cwd") === undefined ? {} : { cwd: stringField(payload, "cwd") }),
    ...(numberField(payload, "timeoutMs") === undefined
      ? {}
      : { timeoutMs: numberField(payload, "timeoutMs") }),
    ...(envRefsField(payload) === undefined ? {} : { envRefs: envRefsField(payload) }),
    ...(stringArrayField(payload, "materialRefs") === undefined
      ? {}
      : { materialRefs: stringArrayField(payload, "materialRefs") }),
    ...(Predicate.isObject(payload.limits) ? { limits: payload.limits as never } : {}),
    claim,
  };
};

const completedFrom = (
  payload: Record<string, unknown>,
): WorkspaceOperationCompletedPayload | undefined => {
  const requestedEventId = numberField(payload, "requestedEventId");
  const operationRef = stringField(payload, "operationRef");
  const workspaceRef = stringField(payload, "workspaceRef");
  const toolName = operationNameFrom(payload.toolName);
  const idempotencyKey = stringField(payload, "idempotencyKey");
  const resultHash = stringField(payload, "resultHash");
  const claim = livedClaimFrom(payload.claim);
  if (
    requestedEventId === undefined ||
    operationRef === undefined ||
    workspaceRef === undefined ||
    toolName === undefined ||
    idempotencyKey === undefined ||
    resultHash === undefined ||
    claim === undefined
  ) {
    return undefined;
  }
  return { ...(payload as WorkspaceOperationCompletedPayload), claim };
};

const rejectedFrom = (
  payload: Record<string, unknown>,
): WorkspaceOperationRejectedPayload | undefined => {
  const requestedEventId = numberField(payload, "requestedEventId");
  const operationRef = stringField(payload, "operationRef");
  const workspaceRef = stringField(payload, "workspaceRef");
  const toolCallId = stringField(payload, "toolCallId");
  const toolName = operationNameFrom(payload.toolName);
  const idempotencyKey = stringField(payload, "idempotencyKey");
  const reason = stringField(payload, "reason");
  const claim = rejectedClaimFrom(payload.claim);
  if (
    requestedEventId === undefined ||
    operationRef === undefined ||
    workspaceRef === undefined ||
    toolName === undefined ||
    idempotencyKey === undefined ||
    reason === undefined ||
    claim === undefined
  ) {
    return undefined;
  }
  return {
    requestedEventId,
    operationRef,
    workspaceRef,
    ...(toolCallId === undefined ? {} : { toolCallId }),
    toolName,
    idempotencyKey,
    reason,
    claim,
  };
};

export const workspaceOperationToolResult = (
  completed: WorkspaceOperationCompletedPayload,
): WorkspaceOperationToolResult => {
  switch (completed.toolName) {
    case "write_file":
      return {
        kind: "write_file",
        path: completed.path ?? "",
        bytesWritten: completed.bytesWritten ?? 0,
        resultHash: completed.resultHash,
      };
    case "bash":
      return {
        kind: "bash",
        command: completed.command ?? "",
        cwd: completed.cwd ?? ".",
        exitCode: completed.exitCode ?? 1,
        stdoutPreview: completed.stdoutPreview ?? "",
        stderrPreview: completed.stderrPreview ?? "",
        stdoutBytes: completed.stdoutBytes ?? 0,
        stderrBytes: completed.stderrBytes ?? 0,
        stdoutTruncated: completed.stdoutTruncated ?? false,
        stderrTruncated: completed.stderrTruncated ?? false,
        stdoutHash: completed.stdoutHash ?? "",
        stderrHash: completed.stderrHash ?? "",
        durationMs: completed.durationMs ?? 0,
        resultHash: completed.resultHash,
      };
  }
};

export const projectWorkspaceOperation = (
  events: Iterable<WorkspaceOperationLedgerEvent>,
  requestedEventId: number,
): WorkspaceOperationProjection => {
  let request: WorkspaceOperationRequestedPayload | undefined;
  let completed: WorkspaceOperationCompletedPayload | undefined;
  let rejected: WorkspaceOperationRejectedPayload | undefined;

  for (const event of events) {
    if (!Predicate.isObject(event.payload)) continue;
    switch (event.kind) {
      case WORKSPACE_OP_KIND.REQUESTED:
        if (event.id === requestedEventId && request === undefined) {
          request = requestFrom(event.id, event.payload);
        }
        break;
      case WORKSPACE_OP_KIND.COMPLETED: {
        const next = completedFrom(event.payload);
        if (next?.requestedEventId === requestedEventId && completed === undefined) {
          completed = next;
        }
        break;
      }
      case WORKSPACE_OP_KIND.REJECTED: {
        const next = rejectedFrom(event.payload);
        if (next?.requestedEventId === requestedEventId && rejected === undefined) {
          rejected = next;
        }
        break;
      }
    }
  }

  if (request === undefined) return { status: "missing", requestedEventId };
  if (completed !== undefined) {
    return {
      status: "completed",
      requestedEventId,
      request,
      completed,
      result: workspaceOperationToolResult(completed),
    };
  }
  if (rejected !== undefined) return { status: "rejected", requestedEventId, request, rejected };
  return { status: "requested", requestedEventId, request };
};
