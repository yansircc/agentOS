import { Predicate } from "effect";
import type { LivedClaim, RejectedClaim } from "@agent-os/kernel/effect-claim";
import { defineEventKindView, defineEventPayloads, payload } from "@agent-os/kernel/extensions";
import { validateTerminalClaim } from "@agent-os/kernel/settlement-contract";
import { deploySettlementContract } from "./settlement";

export interface DeployPreviewRecordedPayload {
  readonly subjectRef: string;
  readonly previewRef: string;
  readonly artifactRef: string;
  readonly claim: LivedClaim;
}

export interface DeployProductionPromotedPayload {
  readonly subjectRef: string;
  readonly deployRef: string;
  readonly productionRef: string;
  readonly rollbackRef?: string;
  readonly claim: LivedClaim;
}

export interface DeployProductionReadbackPayload {
  readonly subjectRef: string;
  readonly productionRef: string;
  readonly readbackRef: string;
  readonly status: "passed" | "failed";
  readonly claim: LivedClaim;
}

export interface DeployRollbackRecordedPayload {
  readonly subjectRef: string;
  readonly rollbackRef: string;
  readonly restoredDeployRef: string;
  readonly claim: LivedClaim;
}

export interface DeployFailedPayload {
  readonly subjectRef: string;
  readonly step: "preview" | "promote" | "readback" | "rollback";
  readonly proofRef: string;
  readonly reason: string;
  readonly claim: RejectedClaim;
}

export const DEPLOY_EVENTS = defineEventPayloads({
  "deploy.preview.recorded": payload<DeployPreviewRecordedPayload>(),
  "deploy.production.promoted": payload<DeployProductionPromotedPayload>(),
  "deploy.production.readback": payload<DeployProductionReadbackPayload>(),
  "deploy.rollback.recorded": payload<DeployRollbackRecordedPayload>(),
  "deploy.failed": payload<DeployFailedPayload>(),
});

export const DEPLOY_KIND = defineEventKindView(DEPLOY_EVENTS, {
  PREVIEW_RECORDED: "deploy.preview.recorded",
  PRODUCTION_PROMOTED: "deploy.production.promoted",
  PRODUCTION_READBACK: "deploy.production.readback",
  ROLLBACK_RECORDED: "deploy.rollback.recorded",
  FAILED: "deploy.failed",
});

export type DeployEventKind = keyof typeof DEPLOY_EVENTS;

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

const stringField = (payload: Record<string, unknown>, key: string): string | undefined =>
  typeof payload[key] === "string" ? payload[key] : undefined;

const livedClaimFrom = (value: unknown): LivedClaim | undefined => {
  const result = validateTerminalClaim(deploySettlementContract, value);
  return result.ok && result.claim.phase === "lived" ? result.claim : undefined;
};

const rejectedClaimFrom = (value: unknown): RejectedClaim | undefined => {
  const result = validateTerminalClaim(deploySettlementContract, value);
  return result.ok && result.claim.phase === "rejected" ? result.claim : undefined;
};

const failureFrom = (payload: Record<string, unknown>): DeployFailedPayload | undefined => {
  const subjectRef = stringField(payload, "subjectRef");
  const proofRef = stringField(payload, "proofRef");
  const reason = stringField(payload, "reason");
  const claim = rejectedClaimFrom(payload.claim);
  const step = payload.step;
  if (
    subjectRef === undefined ||
    proofRef === undefined ||
    reason === undefined ||
    claim === undefined
  ) {
    return undefined;
  }
  if (step !== "preview" && step !== "promote" && step !== "readback" && step !== "rollback") {
    return undefined;
  }
  return { subjectRef, step, proofRef, reason, claim };
};

const hasPreview = (previewRef: string | undefined, artifactRef: string | undefined): boolean =>
  previewRef !== undefined && artifactRef !== undefined;

const hasPromotion = (deployRef: string | undefined, productionRef: string | undefined): boolean =>
  deployRef !== undefined && productionRef !== undefined;

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
    if (!Predicate.isRecord(event.payload)) continue;
    if (event.payload.subjectRef !== subjectRef) continue;
    switch (event.kind) {
      case DEPLOY_KIND.PREVIEW_RECORDED: {
        const nextPreviewRef = stringField(event.payload, "previewRef");
        const nextArtifactRef = stringField(event.payload, "artifactRef");
        if (
          livedClaimFrom(event.payload.claim) === undefined ||
          nextPreviewRef === undefined ||
          nextArtifactRef === undefined
        ) {
          break;
        }
        previewRef = nextPreviewRef;
        artifactRef = nextArtifactRef;
        status = "previewed";
        failure = undefined;
        break;
      }
      case DEPLOY_KIND.PRODUCTION_PROMOTED: {
        const nextDeployRef = stringField(event.payload, "deployRef");
        const nextProductionRef = stringField(event.payload, "productionRef");
        if (
          !hasPreview(previewRef, artifactRef) ||
          livedClaimFrom(event.payload.claim) === undefined ||
          nextDeployRef === undefined ||
          nextProductionRef === undefined
        ) {
          break;
        }
        deployRef = nextDeployRef;
        productionRef = nextProductionRef;
        rollbackRef = stringField(event.payload, "rollbackRef");
        status = "promoted";
        failure = undefined;
        break;
      }
      case DEPLOY_KIND.PRODUCTION_READBACK: {
        const nextProductionRef = stringField(event.payload, "productionRef");
        const nextReadbackRef = stringField(event.payload, "readbackRef");
        if (
          !hasPromotion(deployRef, productionRef) ||
          livedClaimFrom(event.payload.claim) === undefined ||
          nextProductionRef === undefined ||
          nextProductionRef !== productionRef ||
          nextReadbackRef === undefined ||
          (event.payload.status !== "passed" && event.payload.status !== "failed")
        ) {
          break;
        }
        readbackRef = nextReadbackRef;
        status = event.payload.status === "passed" ? "live_verified" : "failed";
        break;
      }
      case DEPLOY_KIND.ROLLBACK_RECORDED: {
        const nextRollbackRef = stringField(event.payload, "rollbackRef");
        const restoredDeployRef = stringField(event.payload, "restoredDeployRef");
        if (
          !hasPromotion(deployRef, productionRef) ||
          livedClaimFrom(event.payload.claim) === undefined ||
          nextRollbackRef === undefined ||
          restoredDeployRef === undefined
        ) {
          break;
        }
        rollbackRef = nextRollbackRef;
        deployRef = restoredDeployRef;
        status = "rolled_back";
        failure = undefined;
        break;
      }
      case DEPLOY_KIND.FAILED: {
        const nextFailure = failureFrom(event.payload);
        if (nextFailure === undefined) break;
        failure = nextFailure;
        status = "failed";
        break;
      }
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
