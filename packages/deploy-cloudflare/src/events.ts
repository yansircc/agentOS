import type { LivedClaim, RejectedClaim } from "@agent-os/core/effect-claim";
import { DEPLOY_EVENT_PREFIX } from "./extension";

export const DEPLOY_EVENTS = {
  PREVIEW_RECORDED: `${DEPLOY_EVENT_PREFIX}preview.recorded`,
  PRODUCTION_PROMOTED: `${DEPLOY_EVENT_PREFIX}production.promoted`,
  PRODUCTION_READBACK: `${DEPLOY_EVENT_PREFIX}production.readback`,
  ROLLBACK_RECORDED: `${DEPLOY_EVENT_PREFIX}rollback.recorded`,
  FAILED: `${DEPLOY_EVENT_PREFIX}failed`,
} as const;

export type DeployEventKind = (typeof DEPLOY_EVENTS)[keyof typeof DEPLOY_EVENTS];

export interface DeployPreviewRecordedPayload {
  readonly subjectRef: string;
  readonly previewRef: string;
  readonly artifactRef: string;
  readonly claim?: LivedClaim;
}

export interface DeployProductionPromotedPayload {
  readonly subjectRef: string;
  readonly deployRef: string;
  readonly productionRef: string;
  readonly rollbackRef?: string;
  readonly claim?: LivedClaim;
}

export interface DeployProductionReadbackPayload {
  readonly subjectRef: string;
  readonly productionRef: string;
  readonly readbackRef: string;
  readonly status: "passed" | "failed";
  readonly claim?: LivedClaim;
}

export interface DeployRollbackRecordedPayload {
  readonly subjectRef: string;
  readonly rollbackRef: string;
  readonly restoredDeployRef: string;
  readonly claim?: LivedClaim;
}

export interface DeployFailedPayload {
  readonly subjectRef: string;
  readonly step: "preview" | "promote" | "readback" | "rollback";
  readonly proofRef: string;
  readonly reason: string;
  readonly claim?: RejectedClaim;
}

export interface DeployLedgerEvent {
  readonly id: number;
  readonly kind: string;
  readonly payload: unknown;
}

export interface DeployProjection {
  readonly subjectRef: string;
  readonly previewRef?: string;
  readonly artifactRef?: string;
  readonly deployRef?: string;
  readonly productionRef?: string;
  readonly readbackRef?: string;
  readonly rollbackRef?: string;
  readonly status:
    | "missing"
    | "previewed"
    | "promoted"
    | "live_verified"
    | "failed"
    | "rolled_back";
  readonly failure?: DeployFailedPayload;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringField = (payload: Record<string, unknown>, key: string): string | undefined =>
  typeof payload[key] === "string" ? payload[key] : undefined;

const failureFrom = (payload: Record<string, unknown>): DeployFailedPayload | undefined => {
  const subjectRef = stringField(payload, "subjectRef");
  const proofRef = stringField(payload, "proofRef");
  const reason = stringField(payload, "reason");
  const step = payload.step;
  if (subjectRef === undefined || proofRef === undefined || reason === undefined) {
    return undefined;
  }
  if (step !== "preview" && step !== "promote" && step !== "readback" && step !== "rollback") {
    return undefined;
  }
  return { subjectRef, step, proofRef, reason };
};

export const projectDeploy = (
  events: Iterable<DeployLedgerEvent>,
  subjectRef: string,
): DeployProjection => {
  let previewRef: string | undefined;
  let artifactRef: string | undefined;
  let deployRef: string | undefined;
  let productionRef: string | undefined;
  let readbackRef: string | undefined;
  let rollbackRef: string | undefined;
  let status: DeployProjection["status"] = "missing";
  let failure: DeployProjection["failure"];

  for (const event of events) {
    if (!isRecord(event.payload)) continue;
    if (event.payload.subjectRef !== subjectRef) continue;
    switch (event.kind) {
      case DEPLOY_EVENTS.PREVIEW_RECORDED:
        previewRef = stringField(event.payload, "previewRef");
        artifactRef = stringField(event.payload, "artifactRef");
        status = "previewed";
        failure = undefined;
        break;
      case DEPLOY_EVENTS.PRODUCTION_PROMOTED:
        deployRef = stringField(event.payload, "deployRef");
        productionRef = stringField(event.payload, "productionRef");
        rollbackRef = stringField(event.payload, "rollbackRef");
        status = "promoted";
        failure = undefined;
        break;
      case DEPLOY_EVENTS.PRODUCTION_READBACK:
        readbackRef = stringField(event.payload, "readbackRef");
        productionRef = stringField(event.payload, "productionRef") ?? productionRef;
        status = event.payload.status === "passed" ? "live_verified" : "failed";
        break;
      case DEPLOY_EVENTS.ROLLBACK_RECORDED:
        rollbackRef = stringField(event.payload, "rollbackRef");
        deployRef = stringField(event.payload, "restoredDeployRef") ?? deployRef;
        status = "rolled_back";
        failure = undefined;
        break;
      case DEPLOY_EVENTS.FAILED:
        failure = failureFrom(event.payload);
        status = "failed";
        break;
    }
  }

  return {
    subjectRef,
    previewRef,
    artifactRef,
    deployRef,
    productionRef,
    readbackRef,
    rollbackRef,
    status,
    failure,
  };
};
