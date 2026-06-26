import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const packageRoot = new URL("..", import.meta.url).pathname;

const walk = (directory: string): readonly string[] => {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(target));
      continue;
    }
    if (entry.isFile()) files.push(target);
  }
  return files.sort((left, right) => left.localeCompare(right));
};

describe("@agent-os/evals package boundary", () => {
  it("does not depend on runtime or provider construction packages", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    const dependencyNames = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ];

    expect(dependencyNames).not.toContain("@agent-os/runtime");
    expect(dependencyNames).not.toContain("@effect/ai-anthropic");
  });

  it("does not import runtime assembly, generated app internals, or provider seams", () => {
    const forbidden = [
      /@agent-os\/runtime/u,
      /submitAgentEffect/u,
      /resolveRuntime/u,
      /run-projector/u,
      /llm-effect-ai/u,
      /create[A-Za-z0-9]*Provider/u,
      /eval-results/u,
    ];
    const offenders = walk(path.join(packageRoot, "src"))
      .filter((file) => file.endsWith(".ts"))
      .flatMap((file) => {
        const text = fs.readFileSync(file, "utf8");
        return forbidden
          .filter((pattern) => pattern.test(text))
          .map((pattern) => `${path.relative(packageRoot, file)} matches ${pattern.source}`);
      });

    expect(offenders).toEqual([]);
  });
});
