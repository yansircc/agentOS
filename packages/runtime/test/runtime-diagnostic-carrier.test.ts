import { describe, expect, it } from "vite-plus/test";
import {
  runtimeDiagnosticCarrier,
  RUNTIME_DIAGNOSTIC_KIND,
  RUNTIME_DIAGNOSTIC_RESERVED_KINDS,
  RUNTIME_DIAGNOSTIC_FACT_OWNER,
} from "../src/runtime-diagnostic-carrier";

describe("runtime diagnostic carrier", () => {
  it("defines all 4 diagnostic event types correctly", () => {
    expect(runtimeDiagnosticCarrier.ownerId).toBe(RUNTIME_DIAGNOSTIC_FACT_OWNER);
    expect(runtimeDiagnosticCarrier.prefix).toBe("runtime_diagnostic.");
    expect(Object.keys(runtimeDiagnosticCarrier.kind)).toEqual(
      expect.arrayContaining([
        "HANDLER_MISSING",
        "HANDLER_FAILED",
        "PROJECTION_TIMEOUT",
        "PREFLIGHT_FAILED",
      ]),
    );
    expect(RUNTIME_DIAGNOSTIC_KIND.HANDLER_MISSING).toBe("runtime_diagnostic.handler_missing");
    expect(RUNTIME_DIAGNOSTIC_KIND.HANDLER_FAILED).toBe("runtime_diagnostic.handler_failed");
    expect(RUNTIME_DIAGNOSTIC_KIND.PROJECTION_TIMEOUT).toBe(
      "runtime_diagnostic.projection_timeout",
    );
    expect(RUNTIME_DIAGNOSTIC_KIND.PREFLIGHT_FAILED).toBe("runtime_diagnostic.preflight_failed");
  });

  it("keeps handler_missing reserved until a required-handler contract exists", () => {
    expect(RUNTIME_DIAGNOSTIC_RESERVED_KINDS).toEqual([RUNTIME_DIAGNOSTIC_KIND.HANDLER_MISSING]);
  });
});
