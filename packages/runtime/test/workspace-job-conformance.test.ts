import { describe } from "@effect/vitest";
import { validateBoundaryEventPayload } from "../src/boundary-commit";
import {
  WORKSPACE_JOB_KIND,
  settleWorkspaceJobArtifactReadbackVerified,
  workspaceJobArtifactReadbackVerifiedPayload,
  workspaceJobBoundaryContract,
  workspaceJobPreClaim,
} from "../src/workspace-job-carrier";
import {
  Effect,
  expect,
  it,
  makeDataPlane,
  makeJobSpec,
  makeServices,
  runJob,
} from "./_workspace-job-harness";

const claimFrom = (payload: unknown) =>
  (payload as { readonly claim?: Record<string, unknown> }).claim;

describe("workspace-job external-effect conformance", () => {
  it.effect("settles readback witness failures through existing indeterminate claim vocabulary", () =>
    Effect.gen(function* () {
      const services = makeServices();
      const projection = yield* runJob(
        makeJobSpec({
          dataPlane: makeDataPlane({
            readTerminalArtifact: async () => {
              throw new Error("provider witness missing");
            },
          }),
        }),
        services,
      );

      expect(projection.status).toBe("reconcile_required");
      const event = services.events.find(
        (candidate) => candidate.kind === WORKSPACE_JOB_KIND.RECONCILE_REQUIRED,
      );
      expect(event).toBeDefined();
      const claim = claimFrom(event?.payload);
      expect(claim).toMatchObject({
        phase: "indeterminate",
        operationRef: "workspace_job:job-1",
        originRef: { originId: "create-1", originKind: "workspace_job" },
        indeterminateRef: {
          indeterminateKind: "reconcile_required",
          carrierRef: "workspace_job:carrier:workspace-job",
        },
      });
      expect(claim?.anchorRef).toBeUndefined();
      expect(claim?.rejectionRef).toBeUndefined();
    }),
  );

  it.effect("keeps provider evidence out of operationRef and origin identity", () =>
    Effect.gen(function* () {
      const providerRef = "candidate:evil-provider-ref";
      const services = makeServices();
      const projection = yield* runJob(
        makeJobSpec({
          dataPlane: makeDataPlane({
            writeTerminalArtifact: async () => ({ artifactRef: providerRef }),
          }),
        }),
        services,
      );

      expect(projection).toMatchObject({
        status: "verified",
        terminalArtifact: { artifactRef: providerRef },
      });
      const claims = services.events.map((event) => claimFrom(event.payload)).filter(Boolean);
      expect(claims.length).toBeGreaterThan(0);
      for (const claim of claims) {
        expect(claim).toMatchObject({
          operationRef: "workspace_job:job-1",
          originRef: { originId: "create-1", originKind: "workspace_job" },
        });
      }
    }),
  );

  it("fails closed when a workspace-job carrier event uses an undeclared anchor kind", () => {
    const claim = workspaceJobPreClaim({
      runId: "job-1",
      idempotencyKey: "create-1",
      scopeRef: { kind: "conversation", scopeId: "workspace-job-runtime" },
      effectAuthorityRef: { authorityClass: "llm_route", authorityId: "test-route" },
    });
    const validClaim = settleWorkspaceJobArtifactReadbackVerified(claim, {
      runId: "job-1",
      requestedEventId: 10,
      artifactRef: "workspace-job://job-1/output/result.json",
      sha256: "sha256:readback",
    });
    const invalidClaim = {
      ...validClaim,
      anchorRef: { ...validClaim.anchorRef, anchorKind: "external_receipt" as const },
    };
    const rejection = validateBoundaryEventPayload(
      workspaceJobBoundaryContract,
      WORKSPACE_JOB_KIND.ARTIFACT_READBACK_VERIFIED,
      workspaceJobArtifactReadbackVerifiedPayload({
        requestedEventId: 10,
        runId: "job-1",
        idempotencyKey: "create-1",
        path: "/output/result.json",
        artifactRef: "workspace-job://job-1/output/result.json",
        submitRunId: 50,
        schemaId: "zeroy.agent_command_result.v1",
        bytes: 24,
        sha256: "sha256:readback",
        claim: invalidClaim,
      }),
    );

    expect(rejection?.issue).toBe("claim_settlement_invalid");
  });
});
