import type { Effect } from "effect";

import type {
  DeployFailedPayload,
  DeployPreviewRecordedPayload,
  DeployProductionPromotedPayload,
  DeployProductionReadbackPayload,
  DeployRollbackRecordedPayload,
} from "./events";

export interface DeployPreviewRequest {
  readonly subjectRef: string;
  readonly artifactRef: string;
  readonly targetRef: string;
}

export interface DeployPromoteRequest {
  readonly subjectRef: string;
  readonly artifactRef: string;
  readonly productionTargetRef: string;
}

export interface DeployReadbackRequest {
  readonly subjectRef: string;
  readonly productionRef: string;
}

export interface DeployRollbackRequest {
  readonly subjectRef: string;
  readonly rollbackRef: string;
}

export interface DeployCloudflareFailure {
  readonly code:
    | "PreviewFailed"
    | "PromotionFailed"
    | "ReadbackFailed"
    | "RollbackFailed"
    | "ProviderFailure";
  readonly reason: string;
  readonly proofRef?: string;
}

export interface DeployCloudflareCarrier {
  readonly preview: (
    request: DeployPreviewRequest,
  ) => Effect.Effect<DeployPreviewRecordedPayload, DeployCloudflareFailure>;
  readonly promote: (
    request: DeployPromoteRequest,
  ) => Effect.Effect<DeployProductionPromotedPayload, DeployCloudflareFailure>;
  readonly readback: (
    request: DeployReadbackRequest,
  ) => Effect.Effect<
    DeployProductionReadbackPayload | DeployFailedPayload,
    DeployCloudflareFailure
  >;
  readonly rollback: (
    request: DeployRollbackRequest,
  ) => Effect.Effect<DeployRollbackRecordedPayload, DeployCloudflareFailure>;
}
