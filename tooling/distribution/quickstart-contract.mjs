import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const contractId = "agentos-ask-quickstart-v1";
const quickstartDocument = "docs/guides/quickstart-node.md";
const expectedFilePaths = ["agent/instructions.md", "agent/agent.json"];
const expectedCommandIds = ["install", "ask"];
const expectedInstallCommand = [
  "pnpm init",
  "pnpm add @yansirplus/core @yansirplus/runtime @yansirplus/client @yansirplus/cli effect",
].join("\n");
const expectedAskCommand =
  'pnpm exec agentos ask "Say hello" --llm test --llm-response "Hello from agentOS"';

const fail = (message) => {
  throw new Error(`quickstart contract: ${message}`);
};

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

const attributesFrom = (text) =>
  Object.fromEntries(
    text
      .trim()
      .split(/\s+/u)
      .filter(Boolean)
      .map((entry) => {
        const separator = entry.indexOf("=");
        if (separator <= 0 || separator === entry.length - 1) {
          fail(`invalid block attribute ${entry}`);
        }
        return [entry.slice(0, separator), entry.slice(separator + 1)];
      }),
  );

export const parseQuickstartBlocks = (markdown) => {
  const files = new Map();
  const commands = new Map();
  const pattern = /^```agentos-(file|command)([^\n]*)\n([\s\S]*?)^```\s*$/gmu;
  for (const match of markdown.matchAll(pattern)) {
    const [, kind, rawAttributes, rawBody] = match;
    const attributes = attributesFrom(rawAttributes);
    const body = rawBody.endsWith("\n") ? rawBody : `${rawBody}\n`;
    if (kind === "file") {
      const filePath = attributes.path;
      if (filePath === undefined || Object.keys(attributes).length !== 1) {
        fail("file blocks require exactly one path attribute");
      }
      if (path.isAbsolute(filePath) || filePath.split("/").includes("..")) {
        fail(`file block escapes the consumer root: ${filePath}`);
      }
      if (files.has(filePath)) fail(`duplicate file block ${filePath}`);
      files.set(filePath, body);
      continue;
    }
    const id = attributes.id;
    if (id === undefined || Object.keys(attributes).length !== 1) {
      fail("command blocks require exactly one id attribute");
    }
    if (commands.has(id)) fail(`duplicate command block ${id}`);
    commands.set(id, body.trim());
  }
  return { files, commands };
};

const sameOrderedValues = (actual, expected) =>
  actual.length === expected.length && actual.every((value, index) => value === expected[index]);

const assertExactBlockSet = (blocks) => {
  if (!sameOrderedValues([...blocks.files.keys()], expectedFilePaths)) {
    fail(`file blocks must be exactly ${expectedFilePaths.join(", ")}`);
  }
  if (!sameOrderedValues([...blocks.commands.keys()], expectedCommandIds)) {
    fail(`command blocks must be exactly ${expectedCommandIds.join(", ")}`);
  }
};

const assertCommandBoundary = (blocks) => {
  if (blocks.commands.get("install") !== expectedInstallCommand) {
    fail("install command must initialize pnpm and install the canonical package set");
  }
  if (blocks.commands.get("ask") !== expectedAskCommand) {
    fail("ask command must be pnpm exec agentos ask with the canonical local test response");
  }
};

const assertProductIntent = (blocks) => {
  if (blocks.files.get("agent/instructions.md")?.trim().length === 0) {
    fail("agent/instructions.md must be non-empty");
  }
  let agent;
  try {
    agent = JSON.parse(blocks.files.get("agent/agent.json"));
  } catch {
    fail("agent/agent.json must be valid JSON");
  }
  if (agent === null || typeof agent !== "object" || Array.isArray(agent)) {
    fail("agent/agent.json must be an object");
  }
  if (!sameOrderedValues(Object.keys(agent).sort(), ["agentId", "kind"])) {
    fail("agent/agent.json fields must be exactly agentId, kind");
  }
  if (typeof agent.agentId !== "string" || agent.agentId.length === 0) {
    fail("agent/agent.json requires agentId");
  }
  if (agent.kind !== "workspace") fail("agent/agent.json kind must be workspace");
};

const assertRecipeProjection = (root) => {
  const recipes = readJson(path.join(root, "docs/agent/recipes.source.json"));
  const recipe = recipes.recipes.find(
    (candidate) => candidate.id === "recipe.natural-language-workspace-agent",
  );
  if (recipe?.tutorial !== quickstartDocument) {
    fail(`natural-language recipe must route to ${quickstartDocument}`);
  }
  for (const evidence of [
    "tooling/distribution/quickstart-contract.mjs",
    "tooling/distribution/consumer.mjs",
  ]) {
    if (!recipe.evidence?.includes(evidence)) fail(`recipe evidence missing ${evidence}`);
  }
};

const assertDistributionComposition = (root) => {
  const dispatcher = fs.readFileSync(
    path.join(root, "tooling/distribution/distribution.mjs"),
    "utf8",
  );
  if (!dispatcher.includes("assertQuickstartContract")) {
    fail("distribution test-consumer does not execute the quickstart contract");
  }
  if (!dispatcher.includes("testInternalConsumer")) {
    fail("distribution test-consumer lost the packed consumer proof");
  }
  const quickstartIndex = dispatcher.indexOf("assertQuickstartContract();");
  const consumerIndex = dispatcher.indexOf("testInternalConsumer();");
  if (quickstartIndex < 0 || consumerIndex < 0 || quickstartIndex > consumerIndex) {
    fail("quickstart contract must precede the packed consumer proof in one command");
  }
};

export const verifyQuickstartContract = ({ root = repoRoot, markdown } = {}) => {
  const tutorial = markdown ?? fs.readFileSync(path.join(root, quickstartDocument), "utf8");
  const blocks = parseQuickstartBlocks(tutorial);

  assertExactBlockSet(blocks);
  assertProductIntent(blocks);
  assertCommandBoundary(blocks);
  assertRecipeProjection(root);
  assertDistributionComposition(root);
  if (!tutorial.includes("build-natural-language-workspace-agent.md")) {
    fail("quickstart must link the generated-target authoring reference");
  }
  return {
    contractId,
    files: Array.from(blocks.files.keys()),
    commands: Array.from(blocks.commands.keys()),
  };
};

export const assertQuickstartContract = () => {
  const result = verifyQuickstartContract();
  console.log(
    `verified canonical quickstart ${result.contractId} (${result.files.length} files, ${result.commands.length} commands)`,
  );
};
