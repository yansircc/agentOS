import { Schema } from "effect";
import { defineCarrier, event, lived } from "@agent-os/kernel/carrier";
import { SYMBOLIC_SETTLEMENT_VALUE_PATTERN } from "@agent-os/kernel/settlement-contract";

export const STAGING_EVENT_PREFIX = "staging.";
const StagingSymbolicRef = Schema.String.pipe(
  Schema.check(Schema.isPattern(new RegExp(SYMBOLIC_SETTLEMENT_VALUE_PATTERN))),
);

export const stagingArtifactCarrier = defineCarrier({
  packageId: "@agent-os/staging-artifact",
  prefix: STAGING_EVENT_PREFIX,
  roles: ["generator", "resolver", "reader"],
  events: {
    artifact_published: event({
      kind: "artifact.published",
      payload: Schema.Struct({
        subjectRef: Schema.String,
        artifactRef: StagingSymbolicRef,
        routeRef: StagingSymbolicRef,
        digest: Schema.String,
      }),
      claim: lived({ key: "claim", anchorKinds: ["carrier_proof"] }),
    }),
    artifact_reaped: event({
      kind: "artifact.reaped",
      payload: Schema.Struct({
        subjectRef: Schema.String,
        artifactRef: StagingSymbolicRef,
        reason: Schema.Literals(["published", "discarded", "expired"]),
      }),
      claim: lived({ key: "claim", anchorKinds: ["carrier_proof"] }),
    }),
  },
});

export const STAGING_KIND = stagingArtifactCarrier.kind;
export const STAGING_EVENTS = stagingArtifactCarrier.events;
export const stagingArtifactBoundaryContract = stagingArtifactCarrier.boundaryContract;
export const stagingArtifactSettlementContract = stagingArtifactCarrier.settlementContract;
export const stagingArtifactBoundaryPackage = stagingArtifactCarrier.boundaryPackage;
