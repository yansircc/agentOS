import { describe, expect, it } from "@effect/vitest";
import { runWorkspaceStateLoop, workspaceProjections } from "../src/workspaceState";

const serialized = (value: unknown): string => JSON.stringify(value);

describe("vibe-like spike workspaceState", () => {
  it("materializes file, git, port, artifact, and url current state from refs", async () => {
    const result = await runWorkspaceStateLoop();

    expect(workspaceProjections.map((projection) => projection.kind)).toEqual([
      "workspace.file",
      "workspace.git",
      "workspace.port",
      "workspace.artifact",
      "workspace.url",
    ]);
    expect(result.file?.state).toMatchObject({
      path: "src/weather.ts",
      blobRef: "blob:weather-source-v1",
      digest: "sha256:file-v1",
      deleted: false,
    });
    expect(result.git?.state).toMatchObject({
      repoRef: "repo:workspace",
      branch: "main",
      statusRef: "git-status:clean",
      diffRef: "git-diff:weather-tool",
    });
    expect(result.port?.state).toMatchObject({
      port: 8787,
      status: "open",
      urlRef: "url:preview-8787",
    });
    expect(result.artifact?.state).toMatchObject({
      artifactId: "artifact:weather-build",
      blobRef: "blob:weather-build",
      digest: "sha256:artifact-v1",
      role: "build",
    });
    expect(result.url?.state).toMatchObject({
      urlRef: "url:preview-8787",
      purpose: "preview",
      status: "ready",
    });

    const states = serialized(result);
    expect(states).not.toMatch(/https?:\/\//);
    expect(states).not.toMatch(/token|secret|account/i);
    expect(states).not.toContain("console.log");
  });
});
