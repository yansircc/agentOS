import { describe, expect, it } from "@effect/vitest";
import { runDeployPathLoop } from "../src/deployPath";
import { productToolNames, productTools, workerDeployReadbackTool } from "../src/productTools";

describe("vibe-like spike product tools and deploy path", () => {
  it("declares only product-needed tools with authority contracts", async () => {
    expect(productToolNames()).toEqual([
      "bounded_shell_exec",
      "file_list",
      "file_read",
      "file_write",
      "git_status_diff",
      "port_probe",
      "port_open",
      "port_close",
      "worker_deploy_readback",
    ]);
    for (const tool of productTools) {
      expect(tool.contract.authorityRef.authorityClass).toMatch(/^vibe-like\./);
      expect(tool.contract.requiredMaterials.length).toBeGreaterThan(0);
      expect(tool.admit).toBeTypeOf("function");
    }

    const deploy = await workerDeployReadbackTool.execute({
      appId: "weather-agent",
      bundleRef: "bundle:weather-agent-v1",
      digest: "sha256:worker-v1",
    });
    expect(deploy).toMatchObject({
      deploymentRef: "deployment:weather-agent",
      readbackDigest: "sha256:worker-v1",
    });
  });

  it("materializes deploy state from symbolic facts only", async () => {
    const row = await runDeployPathLoop();

    expect(row?.state).toEqual({
      appId: "weather-agent",
      status: "readback_ok",
      bundleRef: "bundle:weather-agent-v1",
      workerRef: "worker:weather-agent",
      version: "v1",
      digest: "sha256:worker-v1",
      readbackDigest: "sha256:worker-v1",
    });
    const stateJson = JSON.stringify(row);
    expect(stateJson).not.toMatch(/account|token|secret/i);
    expect(stateJson).not.toMatch(/https?:\/\//);
  });
});
