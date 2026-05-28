import {
  validateEffectClaim,
  type LivedClaim,
  type RejectedClaim,
} from "@agent-os/core/effect-claim";

import { WORKSPACE_SESSION_EVENT_VOCABULARY } from "./extension";

export const WORKSPACE_SESSION_EVENTS = WORKSPACE_SESSION_EVENT_VOCABULARY;

export type WorkspaceSessionEventKind =
  (typeof WORKSPACE_SESSION_EVENTS)[keyof typeof WORKSPACE_SESSION_EVENTS];

export type WorkspaceSessionLifecycleStep = "start" | "restore" | "backup" | "preview" | "destroy";

export type WorkspaceSessionRetention =
  | {
      readonly mode: "ephemeral";
      readonly leaseRef?: string;
      readonly expiresAt?: string;
    }
  | {
      readonly mode: "persistent";
      readonly leaseRef?: string;
      readonly expiresAt?: string;
    };

export interface WorkspaceSessionStartedPayload {
  readonly subjectRef: string;
  readonly sessionRef: string;
  readonly workspaceRootRef: string;
  readonly cleanupRef: string;
  readonly retention?: WorkspaceSessionRetention;
  readonly claim: LivedClaim;
}

export interface WorkspaceSessionRestoredPayload {
  readonly subjectRef: string;
  readonly sessionRef: string;
  readonly backupRef: string;
  readonly workspaceRootRef: string;
  readonly cleanupRef: string;
  readonly retention?: WorkspaceSessionRetention;
  readonly claim: LivedClaim;
}

export interface WorkspaceSessionBackedUpPayload {
  readonly subjectRef: string;
  readonly sessionRef: string;
  readonly backupRef: string;
  readonly expiresAt?: string;
  readonly claim: LivedClaim;
}

export interface WorkspaceSessionPreviewAllocatedPayload {
  readonly subjectRef: string;
  readonly sessionRef: string;
  readonly previewRef: string;
  readonly port: number;
  readonly url?: string;
  readonly claim: LivedClaim;
}

export interface WorkspaceSessionDestroyedPayload {
  readonly subjectRef: string;
  readonly sessionRef: string;
  readonly reason: "completed" | "expired" | "aborted" | "manual";
  readonly claim: LivedClaim;
}

export interface WorkspaceSessionFailedPayload {
  readonly subjectRef: string;
  readonly step: WorkspaceSessionLifecycleStep;
  readonly proofRef?: string;
  readonly reason: string;
  readonly claim: RejectedClaim;
}

export interface WorkspaceSessionLedgerEvent {
  readonly id: number;
  readonly kind: string;
  readonly payload: unknown;
}

export interface WorkspaceSessionPreviewRef {
  readonly previewRef: string;
  readonly port: number;
  readonly url?: string;
}

export interface WorkspaceSessionBackupRef {
  readonly backupRef: string;
  readonly expiresAt?: string;
}

export interface WorkspaceSessionProjection {
  readonly subjectRef: string;
  readonly status: "missing" | "active" | "destroyed" | "failed";
  readonly lastEventKind?: WorkspaceSessionEventKind;
  readonly sessionRef?: string;
  readonly workspaceRootRef?: string;
  readonly cleanupRef?: string;
  readonly retention?: WorkspaceSessionRetention;
  readonly backups: ReadonlyArray<WorkspaceSessionBackupRef>;
  readonly previews: ReadonlyArray<WorkspaceSessionPreviewRef>;
  readonly failure?: WorkspaceSessionFailedPayload;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringField = (payload: Record<string, unknown>, key: string): string | undefined =>
  typeof payload[key] === "string" ? payload[key] : undefined;

const numberField = (payload: Record<string, unknown>, key: string): number | undefined =>
  typeof payload[key] === "number" && Number.isFinite(payload[key]) ? payload[key] : undefined;

const retentionFrom = (value: unknown): WorkspaceSessionRetention | undefined => {
  if (!isRecord(value)) return undefined;
  if (value.mode !== "ephemeral" && value.mode !== "persistent") {
    return undefined;
  }
  const out: {
    mode: WorkspaceSessionRetention["mode"];
    leaseRef?: string;
    expiresAt?: string;
  } = { mode: value.mode };
  if (typeof value.leaseRef === "string") out.leaseRef = value.leaseRef;
  if (typeof value.expiresAt === "string") out.expiresAt = value.expiresAt;
  return out as WorkspaceSessionRetention;
};

const livedClaimFrom = (value: unknown): LivedClaim | undefined => {
  const result = validateEffectClaim(value);
  return result.ok && result.claim.phase === "lived" ? result.claim : undefined;
};

const rejectedClaimFrom = (value: unknown): RejectedClaim | undefined => {
  const result = validateEffectClaim(value);
  return result.ok && result.claim.phase === "rejected" ? result.claim : undefined;
};

const failedPayloadFrom = (
  payload: Record<string, unknown>,
): WorkspaceSessionFailedPayload | undefined => {
  const subjectRef = stringField(payload, "subjectRef");
  const reason = stringField(payload, "reason");
  const claim = rejectedClaimFrom(payload.claim);
  const step = payload.step;
  if (subjectRef === undefined || reason === undefined || claim === undefined) {
    return undefined;
  }
  if (
    step !== "start" &&
    step !== "restore" &&
    step !== "backup" &&
    step !== "preview" &&
    step !== "destroy"
  ) {
    return undefined;
  }
  return {
    subjectRef,
    step,
    reason,
    claim,
    ...(typeof payload.proofRef === "string" ? { proofRef: payload.proofRef } : {}),
  };
};

const pushBackup = (
  backups: WorkspaceSessionBackupRef[],
  backupRef: string,
  expiresAt?: string,
): void => {
  backups.push(expiresAt === undefined ? { backupRef } : { backupRef, expiresAt });
};

const pushPreview = (
  previews: WorkspaceSessionPreviewRef[],
  previewRef: string,
  port: number,
  url?: string,
): void => {
  previews.push(url === undefined ? { previewRef, port } : { previewRef, port, url });
};

const resetLifecycleRefs = (
  backups: WorkspaceSessionBackupRef[],
  previews: WorkspaceSessionPreviewRef[],
): void => {
  backups.length = 0;
  previews.length = 0;
};

const hasOpenSession = (
  status: WorkspaceSessionProjection["status"],
  sessionRef: string | undefined,
  workspaceRootRef: string | undefined,
  cleanupRef: string | undefined,
): boolean =>
  status !== "missing" &&
  status !== "destroyed" &&
  sessionRef !== undefined &&
  workspaceRootRef !== undefined &&
  cleanupRef !== undefined;

export const projectWorkspaceSession = (
  events: Iterable<WorkspaceSessionLedgerEvent>,
  subjectRef: string,
): WorkspaceSessionProjection => {
  let status: WorkspaceSessionProjection["status"] = "missing";
  let lastEventKind: WorkspaceSessionEventKind | undefined;
  let sessionRef: string | undefined;
  let workspaceRootRef: string | undefined;
  let cleanupRef: string | undefined;
  let retention: WorkspaceSessionRetention | undefined;
  let failure: WorkspaceSessionFailedPayload | undefined;
  const backups: WorkspaceSessionBackupRef[] = [];
  const previews: WorkspaceSessionPreviewRef[] = [];

  for (const event of events) {
    if (!isRecord(event.payload)) continue;
    if (event.payload.subjectRef !== subjectRef) continue;
    switch (event.kind) {
      case WORKSPACE_SESSION_EVENTS.STARTED: {
        const nextSessionRef = stringField(event.payload, "sessionRef");
        const nextWorkspaceRootRef = stringField(event.payload, "workspaceRootRef");
        const nextCleanupRef = stringField(event.payload, "cleanupRef");
        if (
          livedClaimFrom(event.payload.claim) === undefined ||
          nextSessionRef === undefined ||
          nextWorkspaceRootRef === undefined ||
          nextCleanupRef === undefined
        ) {
          break;
        }
        resetLifecycleRefs(backups, previews);
        sessionRef = nextSessionRef;
        workspaceRootRef = nextWorkspaceRootRef;
        cleanupRef = nextCleanupRef;
        retention = retentionFrom(event.payload.retention);
        status = "active";
        lastEventKind = event.kind;
        failure = undefined;
        break;
      }
      case WORKSPACE_SESSION_EVENTS.RESTORED: {
        const nextSessionRef = stringField(event.payload, "sessionRef");
        const backupRef = stringField(event.payload, "backupRef");
        const nextWorkspaceRootRef = stringField(event.payload, "workspaceRootRef");
        const nextCleanupRef = stringField(event.payload, "cleanupRef");
        if (
          livedClaimFrom(event.payload.claim) === undefined ||
          nextSessionRef === undefined ||
          backupRef === undefined ||
          nextWorkspaceRootRef === undefined ||
          nextCleanupRef === undefined
        ) {
          break;
        }
        resetLifecycleRefs(backups, previews);
        sessionRef = nextSessionRef;
        workspaceRootRef = nextWorkspaceRootRef;
        cleanupRef = nextCleanupRef;
        retention = retentionFrom(event.payload.retention);
        status = "active";
        lastEventKind = event.kind;
        failure = undefined;
        break;
      }
      case WORKSPACE_SESSION_EVENTS.BACKED_UP: {
        const nextSessionRef = stringField(event.payload, "sessionRef");
        const backupRef = stringField(event.payload, "backupRef");
        if (
          livedClaimFrom(event.payload.claim) === undefined ||
          !hasOpenSession(status, sessionRef, workspaceRootRef, cleanupRef) ||
          nextSessionRef === undefined ||
          nextSessionRef !== sessionRef ||
          backupRef === undefined
        ) {
          break;
        }
        pushBackup(backups, backupRef, stringField(event.payload, "expiresAt"));
        status = "active";
        lastEventKind = event.kind;
        failure = undefined;
        break;
      }
      case WORKSPACE_SESSION_EVENTS.PREVIEW_ALLOCATED: {
        const nextSessionRef = stringField(event.payload, "sessionRef");
        const previewRef = stringField(event.payload, "previewRef");
        const port = numberField(event.payload, "port");
        if (
          livedClaimFrom(event.payload.claim) === undefined ||
          !hasOpenSession(status, sessionRef, workspaceRootRef, cleanupRef) ||
          nextSessionRef === undefined ||
          nextSessionRef !== sessionRef ||
          previewRef === undefined ||
          port === undefined
        ) {
          break;
        }
        pushPreview(previews, previewRef, port, stringField(event.payload, "url"));
        status = "active";
        lastEventKind = event.kind;
        failure = undefined;
        break;
      }
      case WORKSPACE_SESSION_EVENTS.DESTROYED: {
        const nextSessionRef = stringField(event.payload, "sessionRef");
        if (
          livedClaimFrom(event.payload.claim) === undefined ||
          !hasOpenSession(status, sessionRef, workspaceRootRef, cleanupRef) ||
          nextSessionRef === undefined ||
          nextSessionRef !== sessionRef
        ) {
          break;
        }
        status = "destroyed";
        lastEventKind = event.kind;
        failure = undefined;
        break;
      }
      case WORKSPACE_SESSION_EVENTS.FAILED:
        failure = failedPayloadFrom(event.payload);
        if (failure !== undefined) {
          status = "failed";
          lastEventKind = event.kind;
        }
        break;
    }
  }

  return {
    subjectRef,
    status,
    lastEventKind,
    sessionRef,
    workspaceRootRef,
    cleanupRef,
    retention,
    backups,
    previews,
    failure,
  };
};
