#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const protocolFile = "packages/llm-protocol/src/index.ts";
const protocolTest = "packages/llm-protocol/test/llm-protocol.test.ts";
const runtimeTests = "packages/runtime/test";
const providerTests = [
  "packages/providers/llm-transport-effect-ai/test/effect-ai-transport.test.ts",
  "packages/providers/llm-transport-http/test/llm-transport-http.test.ts",
];

const read = (root, file) => fs.readFileSync(path.join(root, file), "utf8");

const replayFunctionBlock = (source) => {
  const start = source.indexOf("export const replayLlmResponseFromSnapshot");
  if (start < 0) return "";
  const end = source.indexOf("\n\n", start);
  return source.slice(start, end < 0 ? undefined : end);
};

const runtimeTestText = (root) => {
  const dir = path.join(root, runtimeTests);
  if (!fs.existsSync(dir)) return "";
  return fs
    .readdirSync(dir)
    .filter((entry) => entry.endsWith(".test.ts"))
    .map((entry) => read(root, path.join(runtimeTests, entry)))
    .join("\n");
};

const collectFailures = (root = repoRoot) => {
  const failures = [];
  const protocol = read(root, protocolFile);
  if (!protocol.includes("export interface LlmCallSnapshot")) {
    failures.push(`${protocolFile}: missing LlmCallSnapshot`);
  }
  if (!protocol.includes("llmCallSnapshotFromResponse")) {
    failures.push(`${protocolFile}: missing snapshot constructor`);
  }
  const replayBlock = replayFunctionBlock(protocol);
  if (replayBlock.length === 0) {
    failures.push(`${protocolFile}: missing replayLlmResponseFromSnapshot`);
  }
  if (/\.(call|generateText|streamText|fetch)\s*\(/.test(replayBlock)) {
    failures.push(`${protocolFile}: replay helper calls live LLM provider adapter`);
  }
  if (/"route"\s*:|readonly route:|route: LlmRoute/.test(replayBlock)) {
    failures.push(`${protocolFile}: replay helper depends on route shape`);
  }
  if (/OpenAI|Anthropic|Gemini|openai|anthropic|gemini/.test(protocol)) {
    failures.push(`${protocolFile}: llm protocol snapshot vocabulary contains vendor token`);
  }

  const tests = [
    read(root, protocolTest),
    runtimeTestText(root),
    ...providerTests.map((file) => read(root, file)),
  ].join("\n");
  if (
    !/replay mode .*LLM.*provider.*not.*called|provider adapter.*not.*called|live LLM.*not.*called/s.test(
      tests,
    )
  ) {
    failures.push("LLM replay tests must assert live provider adapter not called");
  }
  return failures;
};

const writeFixture = (root, file, source) => {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source);
};

const collectSelfTestFailures = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-replay-llm-"));
  try {
    writeFixture(
      root,
      protocolFile,
      [
        "export interface LlmCallSnapshot {}",
        "export const llmCallSnapshotFromResponse = () => ({});",
        "export const replayLlmResponseFromSnapshot = (snapshot) => snapshot.response;",
      ].join("\n"),
    );
    writeFixture(
      root,
      protocolTest,
      "it('replay mode live LLM provider adapter not called', () => {})",
    );
    writeFixture(root, path.join(runtimeTests, "replay.test.ts"), "");
    for (const file of providerTests) writeFixture(root, file, "");
    const baseline = collectFailures(root);
    if (baseline.length > 0) {
      return [`LLM replay positive fixture failed:\n${baseline.join("\n")}`];
    }

    writeFixture(
      root,
      protocolFile,
      [
        "export interface LlmCallSnapshot {}",
        "export const llmCallSnapshotFromResponse = () => ({});",
        "export const replayLlmResponseFromSnapshot = (_snapshot, provider) => provider.call({});",
      ].join("\n"),
    );
    const rejected = collectFailures(root);
    if (!rejected.some((failure) => failure.includes("calls live LLM provider adapter"))) {
      return [`LLM replay mutation fixture was not rejected: ${JSON.stringify(rejected)}`];
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
    ? "replay LLM snapshot self-test passed"
    : "replay LLM snapshot passed",
);
