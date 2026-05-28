import type { Effect } from "effect";
import type { PreClaim, RejectedClaim } from "@agent-os/kernel/effect-claim";

import type { StagingArtifactPublishedPayload, StagingArtifactReapedPayload } from "./events";

export interface StagingPublishRequest {
  readonly claim: PreClaim;
  readonly subjectRef: string;
  readonly artifactSourceRef: string;
  readonly routeKey: string;
}

export interface StagingReapRequest {
  readonly claim: PreClaim;
  readonly subjectRef: string;
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
  readonly claim: RejectedClaim;
}

export interface StagingArtifactCarrier {
  readonly publish: (
    request: StagingPublishRequest,
  ) => Effect.Effect<StagingArtifactPublishedPayload, StagingArtifactFailure>;
  readonly reap: (
    request: StagingReapRequest,
  ) => Effect.Effect<StagingArtifactReapedPayload, StagingArtifactFailure>;
}
