import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const defaultContractPath = path.join(
  "/Users/yansir/code/52/agentOS",
  ".cst/artifacts/quickstart-contract-v1/contract.json",
);

const fail = (message) => {
  throw new Error(`quickstart contract: ${message}`);
};

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

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

const sourceSpecifier = (specifier, publicScope) => {
  if (!specifier.startsWith(`${publicScope}/`)) return specifier;
  return `@agent-os/${specifier.slice(publicScope.length + 1)}`;
};

const entrypointFor = (surface, specifier, publicScope) => {
  const source = sourceSpecifier(specifier, publicScope);
  const packageRecord = surface.packages.find(
    (candidate) => source === candidate.name || source.startsWith(`${candidate.name}/`),
  );
  if (packageRecord === undefined) return undefined;
  const suffix = source.slice(packageRecord.name.length);
  const subpath = suffix.length === 0 ? "." : `.${suffix}`;
  return packageRecord.entrypoints.find((entrypoint) => entrypoint.subpath === subpath);
};

const manualImportSpecifiers = (body) =>
  Array.from(
    body.matchAll(/(?:from\s+|import\s*\(\s*)["'](@[a-z0-9._-]+\/[a-z0-9._/-]+)["']/giu),
    (match) => match[1],
  );

const assertDefaultDirectImports = (blocks, surface, publicScope) => {
  for (const [filePath, body] of blocks.files) {
    for (const specifier of manualImportSpecifiers(body)) {
      const entrypoint = entrypointFor(surface, specifier, publicScope);
      if (entrypoint === undefined || !entrypoint.audiences.includes("default-direct")) {
        fail(`${filePath} manually imports non-default surface ${specifier}`);
      }
    }
  }
};

const assertRequiredBlocks = (blocks, contract) => {
  const missingFiles = contract.requiredAuthoredFiles.filter((file) => !blocks.files.has(file));
  if (missingFiles.length > 0) fail(`missing authored files: ${missingFiles.join(", ")}`);
  const missingCommands = contract.requiredJourney.filter((id) => !blocks.commands.has(id));
  if (missingCommands.length > 0) fail(`missing journey commands: ${missingCommands.join(", ")}`);
};

const assertCommandBoundary = (blocks) => {
  for (const id of ["install", "build", "serve"]) {
    if (!blocks.commands.get(id)?.startsWith("pnpm ")) fail(`${id} must use pnpm`);
  }
  for (const [id, command] of blocks.commands) {
    if (/\b(?:bun|npm|yarn)\s+(?:run|exec|add|install)\b/u.test(command)) {
      fail(`${id} uses a non-canonical package runner`);
    }
  }
};

const assertConfigAxes = (blocks, contract) => {
  const agent = JSON.parse(blocks.files.get("agent/agent.json"));
  if (typeof agent.agentId !== "string" || agent.agentId.length === 0) {
    fail("agent/agent.json requires agentId");
  }
  const config = JSON.parse(blocks.files.get("agentos.config.jsonc"));
  for (const [axis, expected] of [
    ["profile", contract.constraints.profile],
    ["target.kind", contract.constraints.target],
    ["client.kind", contract.constraints.client],
  ]) {
    const actual = axis.split(".").reduce((value, key) => value?.[key], config);
    if (actual !== expected) fail(`${axis} must be ${expected}, received ${String(actual)}`);
  }
};

const assertRecipeProjection = (root, contract) => {
  const recipes = readJson(path.join(root, "docs/agent/recipes.source.json"));
  const recipe = recipes.recipes.find(
    (candidate) => candidate.id === "recipe.natural-language-workspace-agent",
  );
  if (recipe?.tutorial !== contract.tutorial) {
    fail(`natural-language recipe must route to ${contract.tutorial}`);
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

export const verifyQuickstartContract = ({
  root = repoRoot,
  contractPath = defaultContractPath,
  markdown,
} = {}) => {
  const contractText = fs.readFileSync(contractPath, "utf8");
  const contract = JSON.parse(contractText);
  if (contract.schemaVersion !== 1 || contract.id !== "agentos-node-quickstart-v1") {
    fail("unsupported frozen contract");
  }
  const tutorial = markdown ?? fs.readFileSync(path.join(root, contract.tutorial), "utf8");
  const blocks = parseQuickstartBlocks(tutorial);
  const surface = readJson(path.join(root, "docs/surface.json"));
  const publicScope = readJson(path.join(root, "package.json")).agentOsRelease?.npmScope;
  if (typeof publicScope !== "string") fail("package.json is missing agentOsRelease.npmScope");

  assertRequiredBlocks(blocks, contract);
  assertCommandBoundary(blocks);
  assertConfigAxes(blocks, contract);
  assertDefaultDirectImports(blocks, surface, publicScope);
  assertRecipeProjection(root, contract);
  assertDistributionComposition(root);
  if (!tutorial.includes("build-natural-language-workspace-agent.md")) {
    fail("quickstart must link the generated-target authoring reference");
  }
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  if (/\bbun run (?:check|typecheck|test)\b/u.test(readme)) {
    fail("README verification commands must use pnpm");
  }
  return {
    contractId: contract.id,
    contractSha256: sha256(contractText),
    files: Array.from(blocks.files.keys()).sort(),
    commands: Array.from(blocks.commands.keys()).sort(),
  };
};

export const assertQuickstartContract = () => {
  const result = verifyQuickstartContract();
  console.log(
    `verified executable quickstart ${result.contractId} (${result.files.length} files, ${result.commands.length} commands)`,
  );
};

const args = process.argv.slice(2);
if (args[0] === "--contract-lock") {
  const contractPath = path.resolve(args[1] ?? defaultContractPath);
  const rootFlag = args.indexOf("--root");
  const root = rootFlag >= 0 ? path.resolve(args[rootFlag + 1]) : repoRoot;
  const result = verifyQuickstartContract({ root, contractPath });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
