#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const agUiSourcePath = "packages/wire-adapters/ag-ui/src/index.ts";
const agUiPackagePath = "packages/wire-adapters/ag-ui/package.json";
const sseHttpSourcePath = "packages/transports/sse-http/src/index.ts";

const read = (root, file) => fs.readFileSync(path.join(root, file), "utf8");
const readJson = (root, file) => JSON.parse(read(root, file));

const collectFailures = (root = repoRoot) => {
  const failures = [];
  const agUiSource = read(root, agUiSourcePath);
  const sseHttpSource = read(root, sseHttpSourcePath);
  const agUiPackage = readJson(root, agUiPackagePath);

  for (const [name, pattern] of [
    ["event line literal", /["'`]event:\s/u],
    ["data line literal", /["'`]data:\s/u],
    ["TextDecoder", /\bTextDecoder\b/u],
    ["parseSse", /\bparseSse/u],
    ["parseSSE", /\bparseSSE/u],
    ["encodeSseData", /\bencodeSseData\b/u],
  ]) {
    if (pattern.test(agUiSource)) {
      failures.push(`${agUiSourcePath}: AG-UI wire adapter owns SSE codec token ${name}`);
    }
  }

  if (!/from\s+["']@agent-os\/sse-http["']/.test(agUiSource)) {
    failures.push(`${agUiSourcePath}: AG-UI adapter does not import the SSE transport codec`);
  }
  if (agUiPackage.dependencies?.["@agent-os/sse-http"] !== "workspace:*") {
    failures.push(`${agUiPackagePath}: missing @agent-os/sse-http dependency`);
  }
  for (const exported of [
    "encodeSseHttpJsonEvent",
    "decodeSseHttpEvents",
    "parseSseHttpEventBlock",
  ]) {
    if (!new RegExp(`export (?:async function\\*|const) ${exported}\\b`).test(sseHttpSource)) {
      failures.push(`${sseHttpSourcePath}: missing transport-owned ${exported}`);
    }
  }
  return failures;
};

const writeFixture = (root, relativePath, source) => {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
};

const writePositiveFixture = (root) => {
  writeFixture(
    root,
    agUiSourcePath,
    `import { decodeSseHttpEvents, encodeSseHttpJsonEvent } from "@agent-os/sse-http";
export const encodeAgUi = (value) => encodeSseHttpJsonEvent("ag_ui", value);
export async function* project(chunks) {
  for await (const parsed of decodeSseHttpEvents(chunks)) {
    if (parsed.event !== "ledger") continue;
    yield parsed.data;
  }
}
`,
  );
  writeFixture(
    root,
    sseHttpSourcePath,
    `export const encodeSseHttpJsonEvent = () => "";
export const parseSseHttpEventBlock = () => ({ data: "" });
export async function* decodeSseHttpEvents() {}
`,
  );
  writeFixture(
    root,
    agUiPackagePath,
    JSON.stringify({ dependencies: { "@agent-os/sse-http": "workspace:*" } }, null, 2),
  );
};

const collectSelfTestFailures = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-agui-sse-axis-"));
  try {
    writePositiveFixture(root);
    const baseline = collectFailures(root);
    if (baseline.length > 0) {
      return [`AG-UI SSE axis positive fixture failed:\n${baseline.join("\n")}`];
    }

    writeFixture(
      root,
      agUiSourcePath,
      `export const encode = (value) => "event: ag_ui\\ndata: " + JSON.stringify(value) + "\\n\\n";`,
    );
    const rejected = collectFailures(root);
    if (!rejected.some((failure) => failure.includes("event line literal"))) {
      return [`AG-UI SSE axis mutation fixture was not rejected: ${JSON.stringify(rejected)}`];
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
    ? "AG-UI SSE axis self-test passed"
    : "AG-UI SSE axis passed",
);
