import type { LivedClaim } from "@agent-os/core/effect-claim";
import { STAGING_EVENT_PREFIX } from "./extension";

export const STAGING_EVENTS = {
  ARTIFACT_PUBLISHED: `${STAGING_EVENT_PREFIX}artifact.published`,
  ARTIFACT_REAPED: `${STAGING_EVENT_PREFIX}artifact.reaped`,
} as const;

export type StagingEventKind =
  (typeof STAGING_EVENTS)[keyof typeof STAGING_EVENTS];

export interface StagingArtifactPublishedPayload {
  readonly subjectRef: string;
  readonly artifactRef: string;
  readonly routeRef: string;
  readonly digest: string;
  readonly claim?: LivedClaim;
}

export interface StagingArtifactReapedPayload {
  readonly subjectRef: string;
  readonly artifactRef: string;
  readonly reason: "published" | "discarded" | "expired";
  readonly claim?: LivedClaim;
}

export interface StagingLedgerEvent {
  readonly id: number;
  readonly kind: string;
  readonly payload: unknown;
}

export interface StagingArtifactProjection {
  readonly subjectRef: string;
  readonly artifactRef?: string;
  readonly routeRef?: string;
  readonly digest?: string;
  readonly status: "missing" | "published" | "reaped";
  readonly reapedReason?: StagingArtifactReapedPayload["reason"];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringField = (
  payload: Record<string, unknown>,
  key: string,
): string | undefined =>
  typeof payload[key] === "string" ? payload[key] : undefined;

const reapReasonFrom = (
  value: unknown,
): StagingArtifactReapedPayload["reason"] | undefined =>
  value === "published" || value === "discarded" || value === "expired"
    ? value
    : undefined;

export const projectStagingArtifact = (
  events: Iterable<StagingLedgerEvent>,
  subjectRef: string,
): StagingArtifactProjection => {
  let artifactRef: string | undefined;
  let routeRef: string | undefined;
  let digest: string | undefined;
  let status: StagingArtifactProjection["status"] = "missing";
  let reapedReason: StagingArtifactProjection["reapedReason"];

  for (const event of events) {
    if (!isRecord(event.payload)) continue;
    if (event.payload.subjectRef !== subjectRef) continue;
    switch (event.kind) {
      case STAGING_EVENTS.ARTIFACT_PUBLISHED:
        artifactRef = stringField(event.payload, "artifactRef");
        routeRef = stringField(event.payload, "routeRef");
        digest = stringField(event.payload, "digest");
        status = "published";
        reapedReason = undefined;
        break;
      case STAGING_EVENTS.ARTIFACT_REAPED:
        artifactRef = stringField(event.payload, "artifactRef") ?? artifactRef;
        status = "reaped";
        reapedReason = reapReasonFrom(event.payload.reason);
        break;
    }
  }

  return { subjectRef, artifactRef, routeRef, digest, status, reapedReason };
};
