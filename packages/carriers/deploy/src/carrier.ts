import type { Effect } from "effect";
import type { IndeterminateClaim, PreClaim, RejectedClaim } from "@agent-os/core/effect-claim";

import type {
  DeployFailedPayload,
  DeployPreviewRecordedPayload,
  DeployProductionPromotedPayload,
  DeployProductionReadbackPayload,
  DeployReconcileRequiredPayload,
  DeployRollbackRecordedPayload,
} from "./events";

export interface DeployPreviewRequest {
  readonly claim: PreClaim;
  readonly subjectRef: string;
  readonly artifactRef: string;
  readonly targetRef: string;
}

export interface DeployPromoteRequest {
  readonly claim: PreClaim;
  readonly subjectRef: string;
  readonly artifactRef: string;
  readonly productionTargetRef: string;
}

export interface DeployReadbackRequest {
  readonly claim: PreClaim;
  readonly subjectRef: string;
  readonly productionRef: string;
}

export interface DeployRollbackRequest {
  readonly claim: PreClaim;
  readonly subjectRef: string;
  readonly rollbackRef: string;
}

export interface DeployFailure {
  readonly code:
    | "PreviewFailed"
    | "PromotionFailed"
    | "ReadbackFailed"
    | "RollbackFailed"
    | "ProviderFailure";
  readonly reason: string;
  readonly proofRef?: string;
  readonly claim: RejectedClaim;
}

export interface DeployReconcileRequired {
  readonly code: "ReconcileRequired";
  readonly reason: string;
  readonly proofRef: string;
  readonly claim: IndeterminateClaim;
}

export type DeployProviderIssue = DeployFailure | DeployReconcileRequired;

export interface DeployCarrier {
  readonly preview: (
    request: DeployPreviewRequest,
  ) => Effect.Effect<DeployPreviewRecordedPayload | DeployReconcileRequiredPayload, DeployFailure>;
  readonly promote: (
    request: DeployPromoteRequest,
  ) => Effect.Effect<
    DeployProductionPromotedPayload | DeployReconcileRequiredPayload,
    DeployFailure
  >;
  readonly readback: (
    request: DeployReadbackRequest,
  ) => Effect.Effect<
    DeployProductionReadbackPayload | DeployFailedPayload | DeployReconcileRequiredPayload,
    DeployFailure
  >;
  readonly rollback: (
    request: DeployRollbackRequest,
  ) => Effect.Effect<DeployRollbackRecordedPayload | DeployReconcileRequiredPayload, DeployFailure>;
}
