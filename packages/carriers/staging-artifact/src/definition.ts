import { Schema } from "effect";
import { defineCarrier, event, ledgerProjection, lived } from "@agent-os/kernel/carrier";

export const STAGING_EVENT_PREFIX = "staging.";

export const stagingArtifactCarrier = defineCarrier({
  packageId: "@agent-os/staging-artifact",
  prefix: STAGING_EVENT_PREFIX,
  roles: ["generator", "resolver", "reader"],
  events: {
    artifact_published: event({
      kind: "artifact.published",
      payload: Schema.Struct({
        subjectRef: Schema.String,
        artifactRef: Schema.String,
        routeRef: Schema.String,
        digest: Schema.String,
      }),
      claim: lived({ key: "claim", anchorKinds: ["carrier_proof"] }),
    }),
    artifact_reaped: event({
      kind: "artifact.reaped",
      payload: Schema.Struct({
        subjectRef: Schema.String,
        artifactRef: Schema.String,
        reason: Schema.Literal("published", "discarded", "expired"),
      }),
      claim: lived({ key: "claim", anchorKinds: ["carrier_proof"] }),
    }),
  },
  projection: ledgerProjection({
    initial: () => ({ status: "missing" as const }),
    reduce: (state) => state,
  }),
});

export const STAGING_KIND = stagingArtifactCarrier.kind;
export const STAGING_EVENTS = stagingArtifactCarrier.events;
export const stagingArtifactBoundaryContract = stagingArtifactCarrier.boundaryContract;
export const stagingArtifactSettlementContract = stagingArtifactCarrier.settlementContract;
export const stagingArtifactBoundaryPackage = stagingArtifactCarrier.boundaryPackage;
