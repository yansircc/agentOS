import type { Effect } from "effect";

import type {
  StagingArtifactPublishedPayload,
  StagingArtifactReapedPayload,
} from "./events";

export interface StagingPublishRequest {
  readonly changeId: string;
  readonly artifactSourceRef: string;
  readonly routeKey: string;
}

export interface StagingReapRequest {
  readonly changeId: string;
  readonly artifactRef: string;
  readonly reason: StagingArtifactReapedPayload["reason"];
}

export interface StagingArtifactFailure {
  readonly code:
    | "ArtifactUnavailable"
    | "PublishFailed"
    | "RouteFailed"
    | "ReapFailed"
    | "ProviderFailure";
  readonly reason: string;
  readonly proofRef?: string;
}

export interface StagingArtifactCarrier {
  readonly publish: (
    request: StagingPublishRequest,
  ) => Effect.Effect<StagingArtifactPublishedPayload, StagingArtifactFailure>;
  readonly reap: (
    request: StagingReapRequest,
  ) => Effect.Effect<StagingArtifactReapedPayload, StagingArtifactFailure>;
}
