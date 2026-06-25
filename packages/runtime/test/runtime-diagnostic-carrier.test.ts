import { describe, expect, it } from "vite-plus/test";
import {
  runtimeDiagnosticCarrier,
  RUNTIME_DIAGNOSTIC_KIND,
  RUNTIME_DIAGNOSTIC_RESERVED_KINDS,
  RUNTIME_DIAGNOSTIC_FACT_OWNER,
  ProviderMaterialPreflightDetailSchema,
  providerMaterialPreflightDetailJson,
} from "../src/runtime-diagnostic-carrier";
import { Schema } from "effect";

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

  it("owns provider material preflight detail schema", () => {
    const detail = Schema.decodeUnknownSync(ProviderMaterialPreflightDetailSchema)(
      JSON.parse(
        providerMaterialPreflightDetailJson({
          kind: "provider_material_preflight",
          provider: "openai-compatible",
          routeKind: "openai-chat-compatible",
          routeBindingRef: "default",
          routeStatus: "present",
          materials: [
            { kind: "endpoint", ref: "openai", status: "missing" },
            { kind: "credential", ref: "openai-key", status: "present" },
            { kind: "model", ref: "openai-model", status: "present" },
          ],
        }),
      ),
    );
    expect(detail.materials.map((row) => `${row.kind}:${row.ref}:${row.status}`)).toEqual([
      "endpoint:openai:missing",
      "credential:openai-key:present",
      "model:openai-model:present",
    ]);
  });
});
