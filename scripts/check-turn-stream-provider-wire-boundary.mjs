#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const composerSourcePath = "packages/composers/turn-stream/src/index.ts";
const composerTestPath = "packages/composers/turn-stream/test/turn-stream.test.ts";
const runStreamSourcePath = "packages/composers/run-stream/src/index.ts";
const sseHttpSourcePath = "packages/transports/sse-http/src/index.ts";
const effectSkillPath = "docs/effect-skill.json";
const providerSourcePath = "packages/providers/llm-transport-http/src/index.ts";
const providerTestPath = "packages/providers/llm-transport-http/test/llm-transport-http.test.ts";

const adapterExports = [
  "adaptOpenAiCompatibleDeltaChunk",
  "adaptAnthropicDeltaChunk",
  "adaptGeminiDeltaChunk",
];

const providerWireTypes = [
  "TurnStreamDeltaAdapterInput",
  "OpenAiCompatibleDeltaChoice",
  "OpenAiCompatibleDeltaChunk",
  "AnthropicDeltaChunk",
  "GeminiDeltaChunk",
];

const composerForbiddenTokens = [
  ...adapterExports,
  ...providerWireTypes,
  "ProviderDeltaAdapter",
  "OpenAI",
  "Anthropic",
  "Gemini",
  "openai_compatible",
  "anthropic_malformed_chunk",
  "gemini_malformed_chunk",
  "finish_reason",
  "usageMetadata",
  "message_stop",
];

const runStreamForbiddenTokens = [
  "ComposeBatchedSubmitRunStreamSpec",
  "composeBatchedSubmitRunStream",
  "SubmitSpec",
  "submitSpec",
  "agent_os.provider_http_failure",
  "provider_http_failure",
];

const sseHttpForbiddenTokens = [
  "createBatchedSubmitRunStreamResponse",
  "ComposeBatchedSubmitRunStreamSpec",
  "composeBatchedSubmitRunStream",
  "SubmitSpec",
  "submitSpec",
];

const read = (root, file) => fs.readFileSync(path.join(root, file), "utf8");

const sourceFiles = (root) => {
  const files = [];
  const visit = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(file);
      } else if (/\.(?:ts|tsx|mts|cts)$/u.test(entry.name)) {
        files.push(file);
      }
    }
  };
  visit(path.join(root, "packages"));
  return files.sort((left, right) => left.localeCompare(right));
};

const toRepoPath = (root, file) => path.relative(root, file).split(path.sep).join("/");

const lineNumber = (source, index) => source.slice(0, index).split("\n").length;

const turnStreamImportBlocks = (source) => [
  ...source.matchAll(
    /\bimport\s+(?:type\s+)?\{(?<specifiers>[\s\S]*?)\}\s+from\s+["']@agent-os\/turn-stream["']/gu,
  ),
];

const exportedConstPattern = (name) => new RegExp(`\\bexport\\s+const\\s+${name}\\b`, "u");
const exportedInterfacePattern = (name) => new RegExp(`\\bexport\\s+interface\\s+${name}\\b`, "u");

const collectFailures = (root = repoRoot) => {
  const failures = [];
  const composerSource = read(root, composerSourcePath);
  const composerTest = read(root, composerTestPath);
  const runStreamSource = read(root, runStreamSourcePath);
  const sseHttpSource = read(root, sseHttpSourcePath);
  const effectSkill = read(root, effectSkillPath);
  const providerSource = read(root, providerSourcePath);
  const providerTest = read(root, providerTestPath);

  for (const token of composerForbiddenTokens) {
    if (new RegExp(`\\b${token}\\b`, "u").test(composerSource)) {
      failures.push(`${composerSourcePath}: composer source owns provider wire token ${token}`);
    }
  }

  for (const token of runStreamForbiddenTokens) {
    if (new RegExp(`\\b${token}\\b`, "u").test(runStreamSource)) {
      failures.push(`${runStreamSourcePath}: run-stream owns driver/provider token ${token}`);
    }
  }
  if (/\bspec\s*\.\s*submit\s*\(/u.test(runStreamSource)) {
    failures.push(`${runStreamSourcePath}: run-stream calls submit through spec.submit`);
  }
  if (/\bspec\s*\.\s*events\b/u.test(runStreamSource)) {
    failures.push(`${runStreamSourcePath}: run-stream reads ledger events through spec.events`);
  }

  for (const token of sseHttpForbiddenTokens) {
    if (new RegExp(`\\b${token}\\b`, "u").test(sseHttpSource)) {
      failures.push(`${sseHttpSourcePath}: sse-http exposes driver bridge token ${token}`);
    }
  }

  if (/batched run-stream HTTP adapter/u.test(effectSkill)) {
    failures.push(`${effectSkillPath}: stale run-stream HTTP adapter scanner exception`);
  }

  for (const adapter of adapterExports) {
    if (new RegExp(`\\b${adapter}\\b`, "u").test(composerTest)) {
      failures.push(
        `${composerTestPath}: composer tests still exercise provider wire adapter ${adapter}`,
      );
    }
    if (!exportedConstPattern(adapter).test(providerSource)) {
      failures.push(`${providerSourcePath}: provider source does not export ${adapter}`);
    }
    if (!new RegExp(`\\b${adapter}\\b`, "u").test(providerTest)) {
      failures.push(`${providerTestPath}: provider tests do not exercise ${adapter}`);
    }
  }

  for (const wireType of providerWireTypes) {
    if (!exportedInterfacePattern(wireType).test(providerSource)) {
      failures.push(`${providerSourcePath}: provider source does not own ${wireType}`);
    }
  }

  for (const file of sourceFiles(root)) {
    const repoPath = toRepoPath(root, file);
    const source = fs.readFileSync(file, "utf8");
    for (const match of turnStreamImportBlocks(source)) {
      const specifiers = match.groups?.specifiers ?? "";
      for (const adapter of adapterExports) {
        if (new RegExp(`\\b${adapter}\\b`, "u").test(specifiers)) {
          failures.push(
            `${repoPath}:${lineNumber(source, match.index ?? 0)}: imports provider wire adapter ${adapter} from @agent-os/turn-stream`,
          );
        }
      }
    }
  }

  return failures;
};

const writeFixture = (root, relativePath, source) => {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
};

const providerFixture = `import type { TurnStreamFrame } from "@agent-os/turn-stream";

export interface TurnStreamDeltaAdapterInput<TChunk = unknown> {
  readonly turnRef: string;
  readonly seq: number;
  readonly chunk: TChunk;
}

export interface OpenAiCompatibleDeltaChoice {}
export interface OpenAiCompatibleDeltaChunk {}
export interface AnthropicDeltaChunk {}
export interface GeminiDeltaChunk {}

export const adaptOpenAiCompatibleDeltaChunk = (): ReadonlyArray<TurnStreamFrame> => [];
export const adaptAnthropicDeltaChunk = (): ReadonlyArray<TurnStreamFrame> => [];
export const adaptGeminiDeltaChunk = (): ReadonlyArray<TurnStreamFrame> => [];
`;

const providerTestFixture = `import {
  adaptAnthropicDeltaChunk,
  adaptGeminiDeltaChunk,
  adaptOpenAiCompatibleDeltaChunk,
} from "../src";

adaptOpenAiCompatibleDeltaChunk();
adaptAnthropicDeltaChunk();
adaptGeminiDeltaChunk();
`;

const collectSelfTestFailures = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-turn-stream-provider-wire-"));
  try {
    writeFixture(root, composerSourcePath, "export interface TurnStreamFrame {}\n");
    writeFixture(root, composerTestPath, 'import { projectTurnStream } from "../src";\n');
    writeFixture(root, runStreamSourcePath, "export const projectRunStream = () => ({});\n");
    writeFixture(
      root,
      sseHttpSourcePath,
      "export const createSseHttpResponse = () => new Response();\n",
    );
    writeFixture(root, effectSkillPath, '{"scanner":{"exceptions":[]}}\n');
    writeFixture(root, providerSourcePath, providerFixture);
    writeFixture(root, providerTestPath, providerTestFixture);
    const baseline = collectFailures(root);
    if (baseline.length > 0) {
      return [
        `turn-stream provider wire boundary positive fixture failed:\n${baseline.join("\n")}`,
      ];
    }

    writeFixture(
      root,
      composerSourcePath,
      "export const adaptOpenAiCompatibleDeltaChunk = () => [];\n",
    );
    const rejected = collectFailures(root);
    if (!rejected.some((failure) => failure.includes("adaptOpenAiCompatibleDeltaChunk"))) {
      return [
        `turn-stream provider wire boundary mutation fixture was not rejected: ${JSON.stringify(rejected)}`,
      ];
    }

    writeFixture(
      root,
      runStreamSourcePath,
      [
        "export interface ComposeBatchedSubmitRunStreamSpec { readonly submitSpec: SubmitSpec; }",
        "export const composeBatchedSubmitRunStream = async (spec) => {",
        "  await spec.submit(spec.submitSpec);",
        "  await spec.events();",
        "  return 'provider_http_failure';",
        "};",
      ].join("\n"),
    );
    const runStreamRejected = collectFailures(root);
    if (
      !runStreamRejected.some((failure) => failure.includes("composeBatchedSubmitRunStream")) ||
      !runStreamRejected.some((failure) => failure.includes("spec.submit")) ||
      !runStreamRejected.some((failure) => failure.includes("provider_http_failure"))
    ) {
      return [
        `run-stream driver bridge mutation fixture was not rejected: ${JSON.stringify(
          runStreamRejected,
        )}`,
      ];
    }

    writeFixture(root, runStreamSourcePath, "export const projectRunStream = () => ({});\n");
    writeFixture(
      root,
      sseHttpSourcePath,
      "export const createBatchedSubmitRunStreamResponse = (spec: ComposeBatchedSubmitRunStreamSpec) => spec;\n",
    );
    const sseRejected = collectFailures(root);
    if (!sseRejected.some((failure) => failure.includes("createBatchedSubmitRunStreamResponse"))) {
      return [
        `sse-http driver bridge mutation fixture was not rejected: ${JSON.stringify(sseRejected)}`,
      ];
    }

    writeFixture(
      root,
      sseHttpSourcePath,
      "export const createSseHttpResponse = () => new Response();\n",
    );
    writeFixture(
      root,
      effectSkillPath,
      '{"scanner":{"exceptions":[{"reason":"batched run-stream HTTP adapter owns Response construction"}]}}\n',
    );
    const exceptionRejected = collectFailures(root);
    if (!exceptionRejected.some((failure) => failure.includes("stale run-stream HTTP adapter"))) {
      return [
        `stale scanner exception fixture was not rejected: ${JSON.stringify(exceptionRejected)}`,
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
    ? "turn-stream provider wire boundary self-test passed"
    : "turn-stream provider wire boundary passed",
);
