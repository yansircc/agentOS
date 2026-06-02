import { Predicate } from "effect";
import type { LivedClaim, RejectedClaim } from "@agent-os/kernel/effect-claim";
import { validateTerminalClaim } from "@agent-os/kernel/settlement-contract";
import { DEPLOY_EVENTS, DEPLOY_KIND, deploySettlementContract } from "./definition";
export { DEPLOY_EVENTS, DEPLOY_KIND } from "./definition";

type DeployPayloads = typeof DEPLOY_EVENTS;

export type DeployPreviewRecordedPayload = DeployPayloads[(typeof DEPLOY_KIND)["PREVIEW_RECORDED"]];

export type DeployProductionPromotedPayload =
  DeployPayloads[(typeof DEPLOY_KIND)["PRODUCTION_PROMOTED"]];

export type DeployProductionReadbackPayload =
  DeployPayloads[(typeof DEPLOY_KIND)["PRODUCTION_READBACK"]];

export type DeployRollbackRecordedPayload =
  DeployPayloads[(typeof DEPLOY_KIND)["ROLLBACK_RECORDED"]];

export type DeployFailedPayload = DeployPayloads[(typeof DEPLOY_KIND)["FAILED"]];

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

const URL_SHAPED_REF = /^https?:\/\//i;

const symbolicRefField = (payload: Record<string, unknown>, key: string): string | undefined => {
  const value = stringField(payload, key);
  return value === undefined || URL_SHAPED_REF.test(value) ? undefined : value;
};

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
  const proofRef = symbolicRefField(payload, "proofRef");
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
        const nextPreviewRef = symbolicRefField(event.payload, "previewRef");
        const nextArtifactRef = symbolicRefField(event.payload, "artifactRef");
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
        const nextDeployRef = symbolicRefField(event.payload, "deployRef");
        const nextProductionRef = symbolicRefField(event.payload, "productionRef");
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
        rollbackRef = symbolicRefField(event.payload, "rollbackRef");
        status = "promoted";
        failure = undefined;
        break;
      }
      case DEPLOY_KIND.PRODUCTION_READBACK: {
        const nextProductionRef = symbolicRefField(event.payload, "productionRef");
        const nextReadbackRef = symbolicRefField(event.payload, "readbackRef");
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
        const nextRollbackRef = symbolicRefField(event.payload, "rollbackRef");
        const restoredDeployRef = symbolicRefField(event.payload, "restoredDeployRef");
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
