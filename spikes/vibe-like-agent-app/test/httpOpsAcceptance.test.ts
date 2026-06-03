import { HttpApi } from "@effect/platform";
import { describe, expect, it } from "@effect/vitest";
import {
  openApiDocument,
  renderHttpRoute,
  scalarReferenceHtml,
  validateOpenApiDocument,
  vibeLikeHttpApi,
} from "../src/httpSurface";
import { acceptanceThresholds, evaluateAcceptanceMetrics, runOpsLoop } from "../src/opsAcceptance";

describe("vibe-like spike HTTP, ops, and acceptance", () => {
  it("owns an Effect HttpApi inventory and renders OpenAPI plus Scalar routes", () => {
    expect(HttpApi.isHttpApi(vibeLikeHttpApi)).toBe(true);
    expect(validateOpenApiDocument(openApiDocument)).toBe(true);
    expect(renderHttpRoute("/openapi.json")).toMatchObject({
      contentType: "application/json",
      body: openApiDocument,
    });
    expect(renderHttpRoute("/reference")).toMatchObject({ contentType: "text/html" });
    expect(scalarReferenceHtml).toContain("api-reference");
    expect(scalarReferenceHtml).toContain("/openapi.json");
  });

  it("reads projection status and rebuild through spike ops", async () => {
    const ops = await runOpsLoop();

    expect(ops.projectionKinds).toContain("run.workflow");
    expect(ops.projectionKinds).toContain("workspace.file");
    expect(ops.projectionKinds).toContain("tenant.skill");
    expect(ops.projectionKinds).toContain("deploy.app");
    expect(ops.runStatus.status).toBe("current");
    expect(ops.rebuilt.rows).toBe(1);
    expect(ops.toolCount).toBe(9);
  });

  it("keeps acceptance numeric and fails closed on threshold misses", () => {
    expect(evaluateAcceptanceMetrics(acceptanceThresholds)).toEqual({ ok: true });
    expect(
      evaluateAcceptanceMetrics({
        ...acceptanceThresholds,
        firstStreamFrameP95Ms: acceptanceThresholds.firstStreamFrameP95Ms + 1,
      }),
    ).toEqual({ ok: false, failures: ["firstStreamFrameP95Ms"] });
  });
});
