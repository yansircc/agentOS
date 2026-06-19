#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = process.cwd();

const runtimeProjectionFile = "packages/runtime/src/projection.ts";
const runtimeProjectionTest = "packages/runtime/test/projection.test.ts";
const kernelToolsFile = "packages/kernel/src/tools.ts";
const kernelToolsTest = "packages/kernel/test/tools.test.ts";

const read = (root, file) => fs.readFileSync(path.join(root, file), "utf8");

const blockFrom = (source, token) => {
  const start = source.indexOf(token);
  if (start < 0) return "";
  const nextExport = source.indexOf("\nexport ", start + 1);
  return source.slice(start, nextExport < 0 ? undefined : nextExport);
};

const collectFailures = (root = repoRoot) => {
  const failures = [];
  const runtimeProjection = read(root, runtimeProjectionFile);
  const runtimeTest = read(root, runtimeProjectionTest);
  const kernelTools = read(root, kernelToolsFile);
  const kernelTest = read(root, kernelToolsTest);

  for (const required of [
    "export interface ProjectionWaitSpec",
    "export class ProjectionWaitTimedOut",
    "export const waitForProjection",
  ]) {
    if (!runtimeProjection.includes(required))
      failures.push(`${runtimeProjectionFile}: missing ${required}`);
  }
  const waitBlock = blockFrom(runtimeProjection, "export const waitForProjection");
  if (waitBlock.length === 0)
    failures.push(`${runtimeProjectionFile}: missing waitForProjection block`);
  if (/\bPromise\b|new Promise|async\s*\(/.test(waitBlock)) {
    failures.push(`${runtimeProjectionFile}: waitForProjection must stay Effect-native`);
  }
  if (!/MaterializedProjections/.test(waitBlock)) {
    failures.push(
      `${runtimeProjectionFile}: waitForProjection must read through MaterializedProjections`,
    );
  }
  if (!/waits for a projection row through the Effect service/.test(runtimeTest)) {
    failures.push(`${runtimeProjectionTest}: missing Effect service projection wait test`);
  }
  if (!/ProjectionWaitTimedOut/.test(runtimeTest)) {
    failures.push(`${runtimeProjectionTest}: missing projection wait timeout assertion`);
  }

  if (!kernelTools.includes("export interface DefineProductToolSpec")) {
    failures.push(`${kernelToolsFile}: missing DefineProductToolSpec`);
  }
  const productToolBlock = blockFrom(kernelTools, "export const defineProductTool");
  if (productToolBlock.length === 0) failures.push(`${kernelToolsFile}: missing defineProductTool`);
  if (/\bPromise\b|new Promise|async\s*\(/.test(productToolBlock)) {
    failures.push(`${kernelToolsFile}: defineProductTool must stay Effect-native`);
  }
  if (!/defineProductTool/.test(kernelTest) || !/Promise waiter boundary/.test(kernelTest)) {
    failures.push(`${kernelToolsTest}: missing product tool factory Effect-native test`);
  }

  const combined = [runtimeProjection, kernelTools].join("\n");
  if (/awaitProjection:\s*.*Promise|awaitProjection[\s\S]{0,80}Promise/.test(combined)) {
    failures.push("projection wait primitive leaked a Promise-shaped tool waiter");
  }
  return failures;
};

const writeFixture = (root, file, source) => {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source);
};

const collectSelfTestFailures = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-projection-wait-"));
  try {
    writeFixture(
      root,
      runtimeProjectionFile,
      [
        "export interface ProjectionWaitSpec {}",
        "export class ProjectionWaitTimedOut {}",
        "export const waitForProjection = () => MaterializedProjections;",
      ].join("\n"),
    );
    writeFixture(
      root,
      runtimeProjectionTest,
      [
        "it('waits for a projection row through the Effect service', () => {});",
        "expect(error).toBeInstanceOf(ProjectionWaitTimedOut);",
      ].join("\n"),
    );
    writeFixture(
      root,
      kernelToolsFile,
      [
        "export interface DefineProductToolSpec {}",
        "export const defineProductTool = () => defineTool({ execute: () => Effect.succeed({}) });",
      ].join("\n"),
    );
    writeFixture(
      root,
      kernelToolsTest,
      "it('defineProductTool has no Promise waiter boundary', () => {});",
    );
    const baseline = collectFailures(root);
    if (baseline.length > 0) {
      return [`projection wait primitive positive fixture failed:\n${baseline.join("\n")}`];
    }

    writeFixture(
      root,
      runtimeProjectionFile,
      [
        "export interface ProjectionWaitSpec {}",
        "export class ProjectionWaitTimedOut {}",
        "export const waitForProjection = () => new Promise(() => {});",
      ].join("\n"),
    );
    const rejected = collectFailures(root);
    if (!rejected.some((failure) => failure.includes("Effect-native"))) {
      return [
        `projection wait primitive Promise mutation was not rejected: ${JSON.stringify(rejected)}`,
      ];
    }
    return [];
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

const failures = process.argv.includes("--self-test")
  ? collectSelfTestFailures()
  : collectFailures(repoRoot);

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(
  process.argv.includes("--self-test")
    ? "projection wait primitive self-test passed"
    : "projection wait primitive passed",
);
