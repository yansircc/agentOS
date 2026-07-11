import { describe, expect, it } from "@effect/vitest";
import {
  BACKEND_CONFORMANCE_LAW_ID,
  BACKEND_CONFORMANCE_LAWS,
  BACKEND_CONFORMANCE_PROTOCOL_VERSION,
  BACKEND_CONFORMANCE_REQUIRED_CAPABILITIES,
  validateBackendConformanceReport,
  type BackendConformanceReport,
} from "@agent-os/core/backend-protocol";

const validReport = (): BackendConformanceReport => ({
  protocolVersion: BACKEND_CONFORMANCE_PROTOCOL_VERSION,
  backendId: "test-backend",
  capabilities: BACKEND_CONFORMANCE_REQUIRED_CAPABILITIES,
  results: BACKEND_CONFORMANCE_LAWS.map((law) => ({
    lawId: law.id,
    status: "passed",
    issues: [],
  })),
  ok: true,
});

describe("backend conformance report validation", () => {
  it("accepts the exact core-owned manifest", () => {
    expect(validateBackendConformanceReport(validReport())).toMatchObject({ ok: true });
    expect(BACKEND_CONFORMANCE_LAWS).toContainEqual({
      id: BACKEND_CONFORMANCE_LAW_ID.LEDGER_ACK_READABLE,
      title: "ledger acknowledgement is readable",
      requiredCapabilities: ["ledger.commit", "ledger.read"],
    });
  });

  it("rejects the stale durable-ack law id", () => {
    const report = validReport();
    const staleResults = report.results.map((result) =>
      result.lawId === BACKEND_CONFORMANCE_LAW_ID.LEDGER_ACK_READABLE
        ? { ...result, lawId: "ledger.durable-ack" }
        : result,
    );

    expect(validateBackendConformanceReport({ ...report, results: staleResults })).toMatchObject({
      ok: false,
    });
    expect(BACKEND_CONFORMANCE_LAWS.map((law) => law.id)).not.toContain("ledger.durable-ack");
  });

  it("rejects stale versions and incomplete law coverage", () => {
    const report = validReport();
    expect(
      validateBackendConformanceReport({
        ...report,
        protocolVersion: "0",
        results: report.results.slice(1),
      }),
    ).toMatchObject({ ok: false });
  });

  it("rejects duplicate laws, reordered laws, and fabricated ok values", () => {
    const report = validReport();
    const reordered = [report.results[1]!, report.results[0]!, ...report.results.slice(2)];
    expect(validateBackendConformanceReport({ ...report, results: reordered })).toMatchObject({
      ok: false,
    });
    expect(
      validateBackendConformanceReport({
        ...report,
        results: [report.results[0]!, report.results[0]!, ...report.results.slice(2)],
      }),
    ).toMatchObject({ ok: false });
    expect(validateBackendConformanceReport({ ...report, ok: false })).toMatchObject({ ok: false });
  });
});
