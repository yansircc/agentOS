import { describe } from "@effect/vitest";
import { registerWorkspaceJobDataPlaneCases } from "./_workspace-job-data-plane-cases";
import { registerWorkspaceJobIdempotencyCases } from "./_workspace-job-idempotency-cases";
import { registerWorkspaceJobFailureReconcileCases } from "./_workspace-job-failure-reconcile-cases";

describe("runWorkspaceJobEffect", () => {
  registerWorkspaceJobDataPlaneCases();
  registerWorkspaceJobIdempotencyCases();
  registerWorkspaceJobFailureReconcileCases();
});
