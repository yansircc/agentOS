import { describe, expect, it } from "@effect/vitest";
import { runTenantConfigLoop, tenantConfigProjections } from "../src/tenantConfig";

describe("vibe-like spike tenantConfig", () => {
  it("materializes credential and skill metadata without secret or zip bodies", async () => {
    const result = await runTenantConfigLoop();

    expect(tenantConfigProjections.map((projection) => projection.kind)).toEqual([
      "tenant.credential",
      "tenant.skill",
    ]);
    expect(result.credential?.state).toEqual({
      credentialRef: "credential:weather-api",
      provider: "weather",
      purpose: "tool-call",
      status: "active",
    });
    expect(result.skill?.state).toEqual({
      skillId: "weather-tool",
      zipRef: "zip:weather-tool-v1",
      versionHash: "sha256:weather-skill-v1",
      enabled: true,
      status: "enabled",
    });

    const stateJson = JSON.stringify(result);
    expect(stateJson).not.toMatch(/api[_-]?key|secret|token/i);
    expect(stateJson).not.toContain("PK\u0003\u0004");
    expect(stateJson).not.toMatch(/https?:\/\//);
  });
});
