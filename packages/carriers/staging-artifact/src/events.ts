import { Predicate } from "effect";
import type { LivedClaim } from "@agent-os/core/effect-claim";
import { validateTerminalClaim } from "@agent-os/core/settlement-contract";
import { STAGING_EVENTS, STAGING_KIND, stagingArtifactSettlementContract } from "./definition";
export { STAGING_EVENTS, STAGING_KIND } from "./definition";

type StagingPayloads = typeof STAGING_EVENTS;

export type StagingArtifactPublishedPayload =
  StagingPayloads[(typeof STAGING_KIND)["ARTIFACT_PUBLISHED"]];

export type StagingArtifactReapedPayload =
  StagingPayloads[(typeof STAGING_KIND)["ARTIFACT_REAPED"]];

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

const stringField = (payload: Record<string, unknown>, key: string): string | undefined =>
  typeof payload[key] === "string" ? payload[key] : undefined;

const livedClaimFrom = (value: unknown): LivedClaim | undefined => {
  const result = validateTerminalClaim(stagingArtifactSettlementContract, value);
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
    if (!Predicate.isObject(event.payload)) continue;
    if (event.payload.subjectRef !== subjectRef) continue;
    if (livedClaimFrom(event.payload.claim) === undefined) continue;
    switch (event.kind) {
      case STAGING_KIND.ARTIFACT_PUBLISHED: {
        const nextArtifactRef = stringField(event.payload, "artifactRef");
        const nextRouteRef = stringField(event.payload, "routeRef");
        const nextDigest = stringField(event.payload, "digest");
        if (nextArtifactRef === undefined || nextRouteRef === undefined || nextDigest === undefined)
          break;
        artifactRef = nextArtifactRef;
        routeRef = nextRouteRef;
        digest = nextDigest;
        status = "published";
        reapedReason = undefined;
        break;
      }
      case STAGING_KIND.ARTIFACT_REAPED: {
        const nextArtifactRef = stringField(event.payload, "artifactRef");
        if (nextArtifactRef === undefined) break;
        artifactRef = nextArtifactRef;
        status = "reaped";
        reapedReason = reapReasonFrom(event.payload.reason);
        break;
      }
    }
  }

  return { subjectRef, artifactRef, routeRef, digest, status, reapedReason };
};
