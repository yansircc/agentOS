import type { ExtensionCapability } from "@agent-os/kernel/extensions";

import {
  STAGING_EVENTS,
  type StagingArtifactPublishedPayload,
  type StagingArtifactReapedPayload,
} from "./events";

export const commitStagingArtifactPublished = (
  cap: ExtensionCapability,
  payload: StagingArtifactPublishedPayload,
): Promise<{ readonly id: number }> =>
  cap.commit({ event: STAGING_EVENTS.ARTIFACT_PUBLISHED, data: payload });

export const commitStagingArtifactReaped = (
  cap: ExtensionCapability,
  payload: StagingArtifactReapedPayload,
): Promise<{ readonly id: number }> =>
  cap.commit({ event: STAGING_EVENTS.ARTIFACT_REAPED, data: payload });

export const deferStagingArtifactReap = (
  cap: ExtensionCapability,
  at: number,
  payload: StagingArtifactReapedPayload,
): Promise<{ readonly id: number }> =>
  cap.time({ at, event: STAGING_EVENTS.ARTIFACT_REAPED, data: payload });
