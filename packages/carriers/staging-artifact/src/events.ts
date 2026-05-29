import { validateEffectClaim, type LivedClaim } from "@agent-os/kernel/effect-claim";
import { defineEventKindView, defineEventPayloads, payload } from "@agent-os/kernel/extensions";

export interface StagingArtifactPublishedPayload {
  readonly subjectRef: string;
  readonly artifactRef: string;
  readonly routeRef: string;
  readonly digest: string;
  readonly claim: LivedClaim;
}

export interface StagingArtifactReapedPayload {
  readonly subjectRef: string;
  readonly artifactRef: string;
  readonly reason: "published" | "discarded" | "expired";
  readonly claim: LivedClaim;
}

export const STAGING_EVENTS = defineEventPayloads({
  "staging.artifact.published": payload<StagingArtifactPublishedPayload>(),
  "staging.artifact.reaped": payload<StagingArtifactReapedPayload>(),
});

export const STAGING_KIND = defineEventKindView(STAGING_EVENTS, {
  ARTIFACT_PUBLISHED: "staging.artifact.published",
  ARTIFACT_REAPED: "staging.artifact.reaped",
});

export type StagingEventKind = keyof typeof STAGING_EVENTS;

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

const stringField = (payload: Record<string, unknown>, key: string): string | undefined =>
  typeof payload[key] === "string" ? payload[key] : undefined;

const livedClaimFrom = (value: unknown): LivedClaim | undefined => {
  const result = validateEffectClaim(value);
  return result.ok && result.claim.phase === "lived" ? result.claim : undefined;
};

const reapReasonFrom = (value: unknown): StagingArtifactReapedPayload["reason"] | undefined =>
  value === "published" || value === "discarded" || value === "expired" ? value : undefined;

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
    if (livedClaimFrom(event.payload.claim) === undefined) continue;
    switch (event.kind) {
      case STAGING_KIND.ARTIFACT_PUBLISHED:
        artifactRef = stringField(event.payload, "artifactRef");
        routeRef = stringField(event.payload, "routeRef");
        digest = stringField(event.payload, "digest");
        status = "published";
        reapedReason = undefined;
        break;
      case STAGING_KIND.ARTIFACT_REAPED:
        artifactRef = stringField(event.payload, "artifactRef") ?? artifactRef;
        status = "reaped";
        reapedReason = reapReasonFrom(event.payload.reason);
        break;
    }
  }

  return { subjectRef, artifactRef, routeRef, digest, status, reapedReason };
};
