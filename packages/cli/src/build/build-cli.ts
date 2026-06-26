#!/usr/bin/env node

import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  compileAgentTree,
  decodeAgentOsConfig,
  linkWorkspaceStaticTarget,
  normalizeAgentOsConfig,
  type AuthoredAgentTree,
  type AuthoredDynamicResolverDeclaration,
  type AuthoredScheduleDeclaration,
  type AuthoredToolDeclaration,
  type NormalizedAgentOsConfig,
  type StaticTargetLink,
} from "./agent-authoring";
import {
  llmMaterialEnvBindings,
  type LlmMaterialEnvBinding,
  type LlmMaterialEnvKind,
} from "./agent-authoring/config";
import { importBundledModule } from "../lib/ts-module-loader.mjs";
import { WORKSPACE_AGENT_COMMAND } from "@agent-os/core/workspace-agent";
import type { MaterialRef } from "@agent-os/core/material-ref";
import {
  preflightOpenAiCompatibleProviderMaterial,
  type ProviderMaterialPreflightDiagnostic,
} from "@agent-os/runtime/llm-effect-ai/openai-compatible";
import {
  parseEvalConfig,
  parseEvalDefinition,
  type EvalAssertion,
  type EvalConfig,
  type EvalDefinition,
  type EvalEventRecord,
  type EvalJsonObject,
  type EvalJsonValue,
  type EvalObservation,
  type EvalTarget,
} from "@agent-os/evals";

interface BuildArgs {
  readonly cwd: string;
  readonly config: string;
  readonly packageScope?: string;
}

interface InfoArgs {
  readonly cwd: string;
  readonly config: string;
  readonly json: boolean;
}

interface ServeArgs {
  readonly cwd: string;
  readonly config: string;
  readonly packageScope?: string;
  readonly host: string;
  readonly port: number;
  readonly llm: "config" | "test";
  readonly llmResponse: string;
  readonly json: boolean;
}

interface EvalArgs {
  readonly cwd: string;
  readonly config: string;
  readonly packageScope?: string;
  readonly target?: "local" | "remote";
  readonly baseUrl?: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly llm: "config" | "test";
  readonly llmResponse: string;
  readonly json: boolean;
}

interface PreflightLlmArgs {
  readonly cwd: string;
  readonly config: string;
  readonly routeBindingRef: string;
  readonly json: boolean;
}

type CliArgs =
  | { readonly command: "help" }
  | { readonly command: "build"; readonly args: BuildArgs }
  | { readonly command: "info"; readonly args: InfoArgs }
  | { readonly command: "serve" | "dev"; readonly args: ServeArgs }
  | { readonly command: "eval"; readonly args: EvalArgs }
  | { readonly command: "preflight"; readonly args: PreflightLlmArgs };

const parseBuildArgs = (rawArgs: ReadonlyArray<string>): BuildArgs => {
  const args: {
    cwd: string;
    config: string;
    packageScope?: string;
  } = {
    cwd: process.cwd(),
    config: "agentos.config.jsonc",
  };
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    switch (arg) {
      case "--cwd":
        if (rawArgs[index + 1] === undefined) throw new Error("--cwd requires a value");
        args.cwd = rawArgs[index + 1];
        index += 1;
        break;
      case "--config":
        if (rawArgs[index + 1] === undefined) throw new Error("--config requires a value");
        args.config = rawArgs[index + 1];
        index += 1;
        break;
      case "--package-scope":
        if (rawArgs[index + 1] === undefined) throw new Error("--package-scope requires a value");
        args.packageScope = rawArgs[index + 1];
        index += 1;
        break;
      default:
        throw new Error(`unexpected argument ${arg}`);
    }
  }
  return args;
};

const parseInfoArgs = (rawArgs: ReadonlyArray<string>): InfoArgs => {
  const args = {
    cwd: process.cwd(),
    config: "agentos.config.jsonc",
    json: false,
  };
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    switch (arg) {
      case "--cwd":
        if (rawArgs[index + 1] === undefined) throw new Error("--cwd requires a value");
        args.cwd = rawArgs[index + 1];
        index += 1;
        break;
      case "--config":
        if (rawArgs[index + 1] === undefined) throw new Error("--config requires a value");
        args.config = rawArgs[index + 1];
        index += 1;
        break;
      case "--json":
        args.json = true;
        break;
      default:
        throw new Error(`unexpected argument ${arg}`);
    }
  }
  return args;
};

const parsePort = (value: string | undefined): number => {
  if (value === undefined) throw new Error("--port requires a value");
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error("--port must be an integer between 0 and 65535");
  }
  return parsed;
};

const parseServeArgs = (rawArgs: ReadonlyArray<string>): ServeArgs => {
  const args: {
    cwd: string;
    config: string;
    packageScope?: string;
    host: string;
    port: number;
    llm: "config" | "test";
    llmResponse: string;
    json: boolean;
  } = {
    cwd: process.cwd(),
    config: "agentos.config.jsonc",
    host: "127.0.0.1",
    port: 8787,
    llm: "config",
    llmResponse: "ok",
    json: false,
  };
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    switch (arg) {
      case "--cwd":
        if (rawArgs[index + 1] === undefined) throw new Error("--cwd requires a value");
        args.cwd = rawArgs[index + 1];
        index += 1;
        break;
      case "--config":
        if (rawArgs[index + 1] === undefined) throw new Error("--config requires a value");
        args.config = rawArgs[index + 1];
        index += 1;
        break;
      case "--package-scope":
        if (rawArgs[index + 1] === undefined) throw new Error("--package-scope requires a value");
        args.packageScope = rawArgs[index + 1];
        index += 1;
        break;
      case "--host":
        if (rawArgs[index + 1] === undefined) throw new Error("--host requires a value");
        args.host = rawArgs[index + 1];
        index += 1;
        break;
      case "--port":
        args.port = parsePort(rawArgs[index + 1]);
        index += 1;
        break;
      case "--llm": {
        const value = rawArgs[index + 1];
        if (value !== "config" && value !== "test") {
          throw new Error("--llm must be one of config, test");
        }
        args.llm = value;
        index += 1;
        break;
      }
      case "--llm-response":
        if (rawArgs[index + 1] === undefined) throw new Error("--llm-response requires a value");
        args.llmResponse = rawArgs[index + 1];
        index += 1;
        break;
      case "--json":
        args.json = true;
        break;
      default:
        throw new Error(`unexpected argument ${arg}`);
    }
  }
  return args;
};

const parseHeader = (value: string | undefined): readonly [string, string] => {
  if (value === undefined) throw new Error("--header requires a value");
  const separator = value.indexOf("=");
  if (separator <= 0) {
    throw new Error("--header must use name=value");
  }
  const name = value.slice(0, separator).trim().toLowerCase();
  const headerValue = value.slice(separator + 1);
  if (name.length === 0) {
    throw new Error("--header name must be non-empty");
  }
  return [name, headerValue] as const;
};

const parseEvalArgs = (rawArgs: ReadonlyArray<string>): EvalArgs => {
  const args: {
    cwd: string;
    config: string;
    packageScope?: string;
    target?: "local" | "remote";
    baseUrl?: string;
    headers: Record<string, string>;
    llm: "config" | "test";
    llmResponse: string;
    json: boolean;
  } = {
    cwd: process.cwd(),
    config: "agentos.config.jsonc",
    headers: {},
    llm: "config",
    llmResponse: "ok",
    json: false,
  };
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    switch (arg) {
      case "--cwd":
        if (rawArgs[index + 1] === undefined) throw new Error("--cwd requires a value");
        args.cwd = rawArgs[index + 1];
        index += 1;
        break;
      case "--config":
        if (rawArgs[index + 1] === undefined) throw new Error("--config requires a value");
        args.config = rawArgs[index + 1];
        index += 1;
        break;
      case "--package-scope":
        if (rawArgs[index + 1] === undefined) throw new Error("--package-scope requires a value");
        args.packageScope = rawArgs[index + 1];
        index += 1;
        break;
      case "--target": {
        const value = rawArgs[index + 1];
        if (value !== "local" && value !== "remote") {
          throw new Error("--target must be one of local, remote");
        }
        args.target = value;
        index += 1;
        break;
      }
      case "--base-url":
        if (rawArgs[index + 1] === undefined) throw new Error("--base-url requires a value");
        args.baseUrl = rawArgs[index + 1];
        index += 1;
        break;
      case "--header": {
        const [name, value] = parseHeader(rawArgs[index + 1]);
        args.headers[name] = value;
        index += 1;
        break;
      }
      case "--llm": {
        const value = rawArgs[index + 1];
        if (value !== "config" && value !== "test") {
          throw new Error("--llm must be one of config, test");
        }
        args.llm = value;
        index += 1;
        break;
      }
      case "--llm-response":
        if (rawArgs[index + 1] === undefined) throw new Error("--llm-response requires a value");
        args.llmResponse = rawArgs[index + 1];
        index += 1;
        break;
      case "--json":
        args.json = true;
        break;
      default:
        throw new Error(`unexpected argument ${arg}`);
    }
  }
  return Object.freeze({
    ...args,
    headers: Object.freeze({ ...args.headers }),
  });
};

const parsePreflightLlmArgs = (rawArgs: ReadonlyArray<string>): PreflightLlmArgs => {
  const args = {
    cwd: process.cwd(),
    config: "agentos.config.jsonc",
    routeBindingRef: "default",
    json: false,
  };
  const [subcommand, ...rest] = rawArgs;
  if (subcommand !== "llm") {
    throw new Error("preflight: choose llm");
  }
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    switch (arg) {
      case "--cwd":
        if (rest[index + 1] === undefined) throw new Error("--cwd requires a value");
        args.cwd = rest[index + 1];
        index += 1;
        break;
      case "--config":
        if (rest[index + 1] === undefined) throw new Error("--config requires a value");
        args.config = rest[index + 1];
        index += 1;
        break;
      case "--route":
        if (rest[index + 1] === undefined) throw new Error("--route requires a value");
        args.routeBindingRef = rest[index + 1];
        index += 1;
        break;
      case "--json":
        args.json = true;
        break;
      default:
        throw new Error(`unexpected argument ${arg}`);
    }
  }
  return args;
};

const parseArgs = (rawArgs: ReadonlyArray<string>): CliArgs => {
  const [command, ...rest] = rawArgs;
  if (command === undefined || command === "--help" || command === "-h") return { command: "help" };
  if (rest.includes("--help") || rest.includes("-h")) return { command: "help" };
  if (command === "build") return { command: "build", args: parseBuildArgs(rest) };
  if (command === "info") return { command: "info", args: parseInfoArgs(rest) };
  if (command === "serve" || command === "dev") {
    return { command, args: parseServeArgs(rest) };
  }
  if (command === "eval") return { command: "eval", args: parseEvalArgs(rest) };
  if (command === "preflight") return { command: "preflight", args: parsePreflightLlmArgs(rest) };
  throw new Error("choose one of build, info, serve, dev, eval, preflight");
};

const help = `Usage:
  agentos build [--cwd <path>] [--config <path>] [--package-scope <scope>]
  agentos info [--cwd <path>] [--config <path>] [--json]
  agentos serve [--cwd <path>] [--config <path>] [--package-scope <scope>] [--host <host>] [--port <port>] [--llm config|test] [--llm-response <text>] [--json]
  agentos dev [--cwd <path>] [--config <path>] [--package-scope <scope>] [--host <host>] [--port <port>] [--llm config|test] [--llm-response <text>] [--json]
  agentos eval [--cwd <path>] [--config <path>] [--package-scope <scope>] [--target local|remote] [--base-url <url>] [--header <name=value>] [--llm config|test] [--llm-response <text>] [--json]
  agentos preflight llm [--cwd <path>] [--config <path>] [--route <binding-ref>] [--json]

Compiles agent/ + workflows/ + agent/schedules/ + agentos.config.jsonc into .agentos/generated/.
Prints compile-only agent inspection without starting a runtime.
Serves the generated local node app through the CLI-owned public command/event protocol.
Runs evals/**/*.eval.ts against the generated app public command/event/channel protocol.
Checks configured LLM route material before submit without printing material values.
`;

const stripJsonc = (text: string): string => {
  let output = "";
  let index = 0;
  let inString = false;
  let quote = "";
  let escaped = false;
  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];
    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        inString = false;
        quote = "";
      }
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      output += char;
      index += 1;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      output += "\n";
      if (text[index] === "\n") index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) {
        output += text[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      index += 2;
      continue;
    }
    output += char;
    index += 1;
  }
  return output;
};

const removeTrailingCommas = (text: string): string => {
  let output = "";
  let index = 0;
  let inString = false;
  let escaped = false;
  while (index < text.length) {
    const char = text[index];
    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      index += 1;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      index += 1;
      continue;
    }
    if (char === ",") {
      let cursor = index + 1;
      while (/\s/u.test(text[cursor] ?? "")) cursor += 1;
      if (text[cursor] === "}" || text[cursor] === "]") {
        index += 1;
        continue;
      }
    }
    output += char;
    index += 1;
  }
  return output;
};

const readJson = async (file: string): Promise<unknown> => JSON.parse(await readFile(file, "utf8"));

const readJsonc = async (file: string): Promise<unknown> => {
  try {
    return JSON.parse(removeTrailingCommas(stripJsonc(await readFile(file, "utf8"))));
  } catch (error) {
    throw new Error(
      `${path.relative(process.cwd(), file)} is not valid JSONC: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
};

const pathExists = async (file: string): Promise<boolean> => {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return false;
    throw error;
  }
};

const toAuthoredPath = (cwd: string, file: string): string =>
  path.relative(cwd, file).split(path.sep).join("/");

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const inferPackageScope = (
  config: unknown,
  explicitScope: string | undefined,
): string | undefined => {
  if (explicitScope !== undefined) return explicitScope;
  const schema = isRecord(config) && typeof config.$schema === "string" ? config.$schema : "";
  const match = /(?:^|\/)node_modules\/(@[^/]+)\/config\/schema\.json$/u.exec(schema);
  return match?.[1];
};

const loadToolDeclaration = async (file: string): Promise<AuthoredToolDeclaration | undefined> => {
  const mod = await importBundledModule(file, { prefix: "agentos-tool-declaration-" });
  if (!Object.hasOwn(mod, "declaration")) {
    throw new Error(`${file}: missing exported declaration`);
  }
  return mod.declaration as AuthoredToolDeclaration;
};

const loadScheduleDeclaration = async (
  file: string,
): Promise<AuthoredScheduleDeclaration | undefined> => {
  const mod = await importBundledModule(file, { prefix: "agentos-schedule-declaration-" });
  if (!Object.hasOwn(mod, "default")) {
    throw new Error(`${file}: missing default schedule export`);
  }
  return mod.default as AuthoredScheduleDeclaration;
};

const loadDynamicResolverDeclaration = async (
  file: string,
): Promise<AuthoredDynamicResolverDeclaration | undefined> => {
  const mod = await importBundledModule(file, { prefix: "agentos-dynamic-resolver-" });
  if (!Object.hasOwn(mod, "declaration")) {
    throw new Error(`${file}: missing exported declaration`);
  }
  return mod.declaration as AuthoredDynamicResolverDeclaration;
};

type CollectedSourceKind = "regular" | "symlink" | "non_regular";

interface CollectedFile {
  readonly path: string;
  readonly sourceKind: CollectedSourceKind;
}

const collectFiles = async (dir: string): Promise<ReadonlyArray<CollectedFile>> => {
  const files: CollectedFile[] = [];
  const entries = (await readdir(dir, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(file)));
      continue;
    }
    if (entry.isFile()) {
      files.push({ path: file, sourceKind: "regular" });
      continue;
    }
    if (entry.isSymbolicLink()) {
      files.push({ path: file, sourceKind: "symlink" });
      continue;
    }
    files.push({ path: file, sourceKind: "non_regular" });
  }
  return files;
};

const isMainSkillRelativePath = (relativePath: string): boolean => {
  const parts = relativePath.split(path.sep);
  return (
    (parts.length === 1 && (parts[0] ?? "").endsWith(".md")) ||
    (parts.length === 2 && parts[1] === "SKILL.md")
  );
};

const isDynamicResolverRelativePath = (relativePath: string): boolean =>
  relativePath.split(path.sep).at(-1)?.endsWith(".dynamic.ts") ?? false;

const shouldLoadDynamicResolverDeclaration = (
  relativePath: string,
  sourceKind: CollectedSourceKind,
): boolean => sourceKind === "regular" && relativePath.split(path.sep).length === 1;

const loadAuthoredTree = async (cwd: string, agentDir: string): Promise<AuthoredAgentTree> => {
  const files: AuthoredAgentTree["files"][number][] = [
    {
      path: toAuthoredPath(cwd, path.join(agentDir, "instructions.md")),
      kind: "markdown",
      text: await readFile(path.join(agentDir, "instructions.md"), "utf8"),
    },
  ];

  const agentJsonPath = path.join(agentDir, "agent.json");
  if (await pathExists(agentJsonPath)) {
    files.push({
      path: toAuthoredPath(cwd, agentJsonPath),
      kind: "json",
      value: await readJson(agentJsonPath),
    });
  }

  const forbiddenDynamicDir = path.join(agentDir, "dynamic");
  if (await pathExists(forbiddenDynamicDir)) {
    for (const file of await collectFiles(forbiddenDynamicDir)) {
      const relativeDynamicPath = path.relative(forbiddenDynamicDir, file.path);
      if (!isDynamicResolverRelativePath(relativeDynamicPath)) continue;
      files.push({
        path: toAuthoredPath(cwd, file.path),
        kind: "dynamic",
        sourceKind: file.sourceKind,
      });
    }
  }

  const toolsDir = path.join(agentDir, "tools");
  if (await pathExists(toolsDir)) {
    for (const file of await collectFiles(toolsDir)) {
      const relativeToolPath = path.relative(toolsDir, file.path);
      if (isDynamicResolverRelativePath(relativeToolPath)) {
        files.push({
          path: toAuthoredPath(cwd, file.path),
          kind: "dynamic",
          declaration: shouldLoadDynamicResolverDeclaration(relativeToolPath, file.sourceKind)
            ? await loadDynamicResolverDeclaration(file.path)
            : undefined,
          sourceKind: file.sourceKind,
        });
        continue;
      }
      const parts = relativeToolPath.split(path.sep);
      if (parts.length !== 1 || !parts[0]?.endsWith(".ts")) continue;
      if (file.sourceKind !== "regular") continue;
      files.push({
        path: toAuthoredPath(cwd, file.path),
        kind: "tool",
        declaration: await loadToolDeclaration(file.path),
      });
    }
  }

  const channelsDir = path.join(agentDir, "channels");
  if (await pathExists(channelsDir)) {
    for (const file of await collectFiles(channelsDir)) {
      files.push({
        path: toAuthoredPath(cwd, file.path),
        kind: "channel",
        sourceKind: file.sourceKind,
      });
    }
  }

  const workflowsDir = path.join(cwd, "workflows");
  if (await pathExists(workflowsDir)) {
    for (const file of await collectFiles(workflowsDir)) {
      files.push({
        path: toAuthoredPath(cwd, file.path),
        kind: "workflow",
        sourceKind: file.sourceKind,
      });
    }
  }

  const schedulesDir = path.join(agentDir, "schedules");
  if (await pathExists(schedulesDir)) {
    for (const file of await collectFiles(schedulesDir)) {
      files.push({
        path: toAuthoredPath(cwd, file.path),
        kind: "schedule",
        declaration:
          file.sourceKind === "regular" ? await loadScheduleDeclaration(file.path) : undefined,
        sourceKind: file.sourceKind,
      });
    }
  }

  const skillsDir = path.join(agentDir, "skills");
  if (await pathExists(skillsDir)) {
    for (const file of await collectFiles(skillsDir)) {
      const authoredPath = toAuthoredPath(cwd, file.path);
      const relativeSkillPath = path.relative(skillsDir, file.path);
      if (isDynamicResolverRelativePath(relativeSkillPath)) {
        files.push({
          path: authoredPath,
          kind: "dynamic",
          declaration: shouldLoadDynamicResolverDeclaration(relativeSkillPath, file.sourceKind)
            ? await loadDynamicResolverDeclaration(file.path)
            : undefined,
          sourceKind: file.sourceKind,
        });
        continue;
      }
      if (isMainSkillRelativePath(relativeSkillPath)) {
        files.push({
          path: authoredPath,
          kind: "markdown",
          text: file.sourceKind === "regular" ? await readFile(file.path, "utf8") : "",
          sourceKind: file.sourceKind,
        });
        continue;
      }
      files.push({
        path: authoredPath,
        kind: "text",
        bytes: file.sourceKind === "regular" ? await readFile(file.path) : new Uint8Array(),
        sourceKind: file.sourceKind,
      });
    }
  }

  const instructionFragmentsDir = path.join(agentDir, "instructions");
  if (await pathExists(instructionFragmentsDir)) {
    for (const file of await collectFiles(instructionFragmentsDir)) {
      const authoredPath = toAuthoredPath(cwd, file.path);
      const relativeInstructionPath = path.relative(instructionFragmentsDir, file.path);
      if (isDynamicResolverRelativePath(relativeInstructionPath)) {
        files.push({
          path: authoredPath,
          kind: "dynamic",
          declaration: shouldLoadDynamicResolverDeclaration(
            relativeInstructionPath,
            file.sourceKind,
          )
            ? await loadDynamicResolverDeclaration(file.path)
            : undefined,
          sourceKind: file.sourceKind,
        });
        continue;
      }
      if (file.path.endsWith(".md")) {
        files.push({
          path: authoredPath,
          kind: "markdown",
          text: file.sourceKind === "regular" ? await readFile(file.path, "utf8") : "",
          sourceKind: file.sourceKind,
        });
        continue;
      }
      files.push({
        path: authoredPath,
        kind: "text",
        bytes: file.sourceKind === "regular" ? await readFile(file.path) : new Uint8Array(),
        sourceKind: file.sourceKind,
      });
    }
  }

  return { files };
};

const writeGeneratedFiles = async (
  cwd: string,
  files: ReadonlyArray<{ readonly path: string; readonly text: string }>,
): Promise<void> => {
  await rm(path.join(cwd, ".agentos", "generated"), { recursive: true, force: true });
  for (const file of files) {
    const output = path.join(cwd, file.path);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, file.text);
  }
};

interface CompileFacts {
  readonly cwd: string;
  readonly normalized: NormalizedAgentOsConfig;
  readonly linked: StaticTargetLink;
}

const loadCompileFacts = async (
  args: Pick<BuildArgs, "cwd" | "config" | "packageScope">,
): Promise<CompileFacts> => {
  const cwd = path.resolve(args.cwd);
  const configPath = path.resolve(cwd, args.config);
  const configValue = await readJsonc(configPath);
  const packageScope = inferPackageScope(configValue, args.packageScope);
  const decodedConfig = decodeAgentOsConfig(configValue);
  if (!decodedConfig.ok) {
    throw new Error(
      `agentos.config.jsonc invalid: ${JSON.stringify(decodedConfig.issues, null, 2)}`,
    );
  }

  const agentDir = path.resolve(cwd, decodedConfig.value.agent);
  const tree = await loadAuthoredTree(cwd, agentDir);
  const compiled = compileAgentTree(tree);
  if (!compiled.ok) {
    throw new Error(`agent tree invalid: ${JSON.stringify(compiled.issues, null, 2)}`);
  }

  const normalized = normalizeAgentOsConfig(decodedConfig.value, compiled.value);
  if (!normalized.ok) {
    throw new Error(
      `agentos config normalization failed: ${JSON.stringify(normalized.issues, null, 2)}`,
    );
  }

  const linked = linkWorkspaceStaticTarget(
    normalized.value,
    packageScope === undefined ? {} : { packageScope },
  );
  if (!linked.ok) {
    throw new Error(`static target link failed: ${JSON.stringify(linked.issues, null, 2)}`);
  }

  return { cwd, normalized: normalized.value, linked: linked.value };
};

const unavailable = (reason: string) => ({ status: "unavailable" as const, reason });

const manifestCapabilityBindingRefs = (
  capabilities: NormalizedAgentOsConfig["deployment"]["manifest"]["capabilities"],
): ReadonlyArray<string> =>
  Object.values(capabilities ?? {})
    .map((capability) => capability.bindingRef)
    .sort((left, right) => left.localeCompare(right));

const projectInfo = (facts: CompileFacts) => ({
  compile: {
    status: "available" as const,
    cwd: facts.cwd,
    profile: facts.normalized.profile,
    target: facts.normalized.target.kind,
    agent: {
      id: facts.normalized.deployment.manifest.agentId,
      scope: facts.normalized.deployment.manifest.scope,
    },
    deployment: {
      id: facts.normalized.deployment.deploymentId,
      backend: facts.normalized.deployment.backend,
      adapter: facts.normalized.deployment.adapter,
      version: facts.normalized.deploymentVersion,
    },
    manifest: {
      host: facts.normalized.target.kind,
      capabilities: manifestCapabilityBindingRefs(
        facts.normalized.deployment.manifest.capabilities,
      ),
      tools: Object.keys(facts.normalized.deployment.manifest.tools ?? {}).sort((left, right) =>
        left.localeCompare(right),
      ),
      workflows: facts.normalized.workflows.map((workflow) => workflow.name),
      schedules: facts.normalized.schedules.map((schedule) => schedule.scheduleId),
    },
    generated: {
      files: facts.linked.files.map((file) => file.path),
      mount: facts.linked.mount,
      canonicalDeployment: facts.linked.canonicalDeployment,
    },
    provenance: facts.normalized.provenance,
  },
  resolve: unavailable("agentos info is compile-only; resolved install graph is unavailable"),
  runtime: unavailable("agentos info does not start a local or Cloudflare runtime"),
});

type PreflightMaterialStatus = "present" | "missing" | "invalid" | "resolver_threw";

interface PreflightDiagnostic {
  readonly pass: string;
  readonly reason: string;
  readonly detail?: string;
}

interface DevVarsIssue {
  readonly file: ".dev.vars";
  readonly line: number;
  readonly reason: "missing_separator" | "invalid_name" | "unterminated_quote";
  readonly key?: string;
}

interface PreflightEnvProjection {
  readonly sources: ReadonlyArray<".dev.vars" | "process.env">;
  readonly values: Readonly<Record<string, string>>;
  readonly valueSources: Readonly<Record<string, ".dev.vars" | "process.env">>;
  readonly issues: ReadonlyArray<DevVarsIssue>;
}

interface ProviderMaterialDetail {
  readonly routeStatus?: string;
  readonly materials?: ReadonlyArray<{
    readonly kind?: string;
    readonly ref?: string;
    readonly status?: string;
  }>;
}

const envNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/u;

const unwrapDevVarsValue = (
  rawValue: string,
  line: number,
):
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly issue: DevVarsIssue } => {
  if (rawValue.length < 2) return { ok: true, value: rawValue };
  const quote = rawValue[0];
  if (quote !== "'" && quote !== '"') return { ok: true, value: rawValue };
  if (!rawValue.endsWith(quote)) {
    return {
      ok: false,
      issue: { file: ".dev.vars", line, reason: "unterminated_quote" },
    };
  }
  const inner = rawValue.slice(1, -1);
  if (quote === "'") return { ok: true, value: inner };
  return {
    ok: true,
    value: inner.replace(/\\([nrt"\\])/gu, (_match, escaped: string) => {
      if (escaped === "n") return "\n";
      if (escaped === "r") return "\r";
      if (escaped === "t") return "\t";
      return escaped;
    }),
  };
};

const parseDevVars = (
  text: string,
): {
  readonly values: Readonly<Record<string, string>>;
  readonly issues: ReadonlyArray<DevVarsIssue>;
} => {
  const values: Record<string, string> = {};
  const issues: DevVarsIssue[] = [];
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const trimmed = lines[index].trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      issues.push({ file: ".dev.vars", line: lineNumber, reason: "missing_separator" });
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    if (!envNamePattern.test(key)) {
      issues.push({ file: ".dev.vars", line: lineNumber, reason: "invalid_name", key });
      continue;
    }
    const value = unwrapDevVarsValue(trimmed.slice(separator + 1).trim(), lineNumber);
    if (!value.ok) {
      issues.push({ ...value.issue, key });
      continue;
    }
    values[key] = value.value;
  }
  return { values, issues };
};

const isNotFoundError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { readonly code?: unknown }).code === "ENOENT";

const readPreflightEnv = async (cwd: string): Promise<PreflightEnvProjection> => {
  const values: Record<string, string> = {};
  const valueSources: Record<string, ".dev.vars" | "process.env"> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== "string") continue;
    values[key] = value;
    valueSources[key] = "process.env";
  }
  const sources = new Set<".dev.vars" | "process.env">(["process.env"]);
  const devVarsPath = path.join(cwd, ".dev.vars");
  try {
    const parsed = parseDevVars(await readFile(devVarsPath, "utf8"));
    sources.add(".dev.vars");
    for (const [key, value] of Object.entries(parsed.values)) {
      values[key] = value;
      valueSources[key] = ".dev.vars";
    }
    return { sources: [...sources], values, valueSources, issues: parsed.issues };
  } catch (error) {
    if (isNotFoundError(error)) return { sources: [...sources], values, valueSources, issues: [] };
    throw error;
  }
};

const providerMaterialDetailFrom = (
  diagnostics: ReadonlyArray<ProviderMaterialPreflightDiagnostic>,
): ProviderMaterialDetail | undefined => {
  const diagnostic = diagnostics.find((item) => item.pass === "provider_material");
  if (diagnostic === undefined) return undefined;
  const parsed: unknown = JSON.parse(diagnostic.detail);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  return parsed as ProviderMaterialDetail;
};

const materialStatusFromDetail = (
  detail: ProviderMaterialDetail | undefined,
  kind: LlmMaterialEnvKind,
  fallback: PreflightMaterialStatus,
): PreflightMaterialStatus => {
  const row = detail?.materials?.find((item) => item.kind === kind);
  const status = row?.status;
  return status === "present" ||
    status === "missing" ||
    status === "invalid" ||
    status === "resolver_threw"
    ? status
    : fallback;
};

const materialValueFor = (
  binding: LlmMaterialEnvBinding,
  env: PreflightEnvProjection,
): string | null => env.values[binding.envName] ?? null;

const preflightDiagnostic = (
  pass: string,
  reason: string,
  detail: object,
): PreflightDiagnostic => ({ pass, reason, detail: JSON.stringify(detail) });

const runPreflightLlm = async (args: PreflightLlmArgs): Promise<void> => {
  const facts = await loadCompileFacts({ cwd: args.cwd, config: args.config });
  const routeBindingRef = args.routeBindingRef;
  const availableRoutes = ["default"] as const;
  const env = await readPreflightEnv(facts.cwd);
  const envDiagnostics: PreflightDiagnostic[] = env.issues.map((issue) =>
    preflightDiagnostic("env_file", ".dev.vars is invalid", issue),
  );
  if (!availableRoutes.includes(routeBindingRef as "default")) {
    const output = {
      protocol: "agentos-preflight-llm@1",
      ok: false,
      cwd: facts.cwd,
      config: args.config,
      route: {
        bindingRef: routeBindingRef,
        status: "missing",
        available: availableRoutes,
      },
      materials: [],
      diagnostics: [
        ...envDiagnostics,
        preflightDiagnostic("llm_route", "LLM route binding not found", {
          requested: routeBindingRef,
          available: availableRoutes,
        }),
      ],
    };
    printPreflightLlm(output, args.json);
    process.exitCode = 1;
    return;
  }

  const bindings = llmMaterialEnvBindings(facts.normalized.llm);
  const bindingByKind = Object.fromEntries(
    bindings.map((binding) => [binding.kind, binding]),
  ) as Record<LlmMaterialEnvKind, LlmMaterialEnvBinding>;
  const modelValue = materialValueFor(bindingByKind.model, env);
  const refResolver = {
    material: (ref: MaterialRef): NonNullable<unknown> | null => {
      const binding = bindings.find(
        (candidate) => candidate.kind === ref.kind && candidate.ref === ref.ref,
      );
      return binding === undefined ? null : materialValueFor(binding, env);
    },
  };
  const providerDiagnostics =
    envDiagnostics.length > 0
      ? []
      : preflightOpenAiCompatibleProviderMaterial({
          route: {
            kind: facts.normalized.llm.route,
            endpointRef: facts.normalized.llm.endpointRef,
            credentialRef: facts.normalized.llm.credentialRef,
            modelId: typeof modelValue === "string" ? modelValue : "",
          },
          refResolver,
          routeBindingRef,
          modelMaterial: {
            ref: facts.normalized.llm.modelRef,
            value: modelValue,
          },
        });
  const providerDetail = providerMaterialDetailFrom(providerDiagnostics);
  const diagnostics: ReadonlyArray<PreflightDiagnostic | ProviderMaterialPreflightDiagnostic> = [
    ...envDiagnostics,
    ...providerDiagnostics,
  ];
  const ok = diagnostics.length === 0;
  const materials = bindings.map((binding) => ({
    kind: binding.kind,
    ref: binding.ref,
    envName: binding.envName,
    source: env.valueSources[binding.envName] ?? "none",
    status: materialStatusFromDetail(providerDetail, binding.kind, ok ? "present" : "invalid"),
  }));
  const output = {
    protocol: "agentos-preflight-llm@1",
    ok,
    cwd: facts.cwd,
    config: args.config,
    route: {
      bindingRef: routeBindingRef,
      status: providerDetail?.routeStatus ?? (ok ? "present" : "invalid"),
      kind: facts.normalized.llm.route,
    },
    env: {
      sources: env.sources,
    },
    materials,
    diagnostics,
  };
  printPreflightLlm(output, args.json);
  if (!ok) process.exitCode = 1;
};

const printPreflightLlm = (
  output: Readonly<{
    readonly ok: boolean;
    readonly route: Readonly<{
      readonly bindingRef: string;
      readonly status: string;
      readonly kind?: string;
    }>;
    readonly materials: ReadonlyArray<
      Readonly<{
        readonly kind: string;
        readonly ref: string;
        readonly envName: string;
        readonly source: string;
        readonly status: string;
      }>
    >;
    readonly diagnostics: ReadonlyArray<
      Readonly<{ readonly pass: string; readonly reason: string }>
    >;
  }>,
  json: boolean,
): void => {
  if (json) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return;
  }
  const lines = [
    `agentOS LLM preflight ${output.ok ? "passed" : "failed"}`,
    `route: ${output.route.bindingRef} (${output.route.kind ?? "unknown"}) ${output.route.status}`,
    ...output.materials.map((row) => `${row.kind}: ${row.status} ${row.envName} (${row.source})`),
    ...output.diagnostics.map(
      (diagnostic) => `diagnostic: ${diagnostic.pass} - ${diagnostic.reason}`,
    ),
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
};

interface LocalAgentApp {
  readonly runtime: {
    readonly submit: (input: unknown) => Promise<unknown>;
    readonly events: (opts?: { readonly afterId?: number }) => ReadonlyArray<unknown>;
    readonly diagnostics: () => ReadonlyArray<unknown>;
    readonly inspect: () => unknown;
  };
  readonly sessions?: {
    readonly submitTurn: (input: unknown) => Promise<unknown>;
    readonly inspect: (sessionRef: string) => unknown;
    readonly list: () => unknown;
  };
  readonly workflows?: {
    readonly run: (input: unknown) => Promise<unknown>;
    readonly inspectRun: (workflowId: string, workflowRunId: string) => unknown;
    readonly listRuns: (workflowId: string) => unknown;
  };
  readonly channels?: {
    readonly handle: (request: Request) => Promise<Response | null>;
  };
  readonly customCommand?: (input: unknown) => Promise<unknown>;
}

interface GeneratedLocalModule {
  readonly createLocalAgentApp?: (
    options?: Readonly<Record<string, unknown>>,
  ) => Promise<LocalAgentApp>;
}

interface CommandRequest {
  readonly name: string;
  readonly input: unknown;
}

const PRODUCT_COMMAND = {
  SUBMIT_SESSION_TURN: "submitSessionTurn",
  INSPECT_SESSION: "inspectSession",
  LIST_SESSIONS: "listSessions",
  RUN_WORKFLOW: "runWorkflow",
  INSPECT_WORKFLOW_RUN: "inspectWorkflowRun",
  LIST_WORKFLOW_RUNS: "listWorkflowRuns",
} as const;

class HttpFailure extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const isPlainRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const requireStringField = (
  value: Readonly<Record<string, unknown>>,
  field: string,
  message: string,
): string => {
  const fieldValue = value[field];
  if (typeof fieldValue !== "string" || fieldValue.length === 0) {
    throw new HttpFailure(400, message);
  }
  return fieldValue;
};

const assertSubmitRunInput = (value: unknown, label: string): unknown => {
  if (!isPlainRecord(value)) throw new HttpFailure(400, `invalid ${label} command input`);
  if (typeof value.intent !== "string" || !isPlainRecord(value.context)) {
    throw new HttpFailure(400, `invalid ${label} submit run input`);
  }
  return value;
};

const commandRequestFromUnknown = (value: unknown): CommandRequest => {
  if (!isPlainRecord(value)) throw new HttpFailure(400, "command request must be an object");
  const name = requireStringField(value, "name", "command request name must be a non-empty string");
  return { name, input: value.input };
};

const jsonResponse = (
  response: http.ServerResponse,
  status: number,
  body: Readonly<Record<string, unknown>>,
): void => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(body)}\n`);
};

const errorResponse = (response: http.ServerResponse, error: unknown): void => {
  const status = error instanceof HttpFailure ? error.status : 500;
  const message = error instanceof Error ? error.message : String(error);
  jsonResponse(response, status, { ok: false, error: { message } });
};

const notFound = (response: http.ServerResponse): void => {
  jsonResponse(response, 404, { ok: false, error: { message: "not found" } });
};

const readJsonBody = (request: http.IncomingMessage): Promise<unknown> =>
  new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new HttpFailure(413, "request body too large"));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(body.trim().length === 0 ? {} : JSON.parse(body));
      } catch {
        reject(new HttpFailure(400, "request body must be JSON"));
      }
    });
    request.on("error", reject);
  });

const readRawBody = async (request: http.IncomingMessage): Promise<Uint8Array> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.byteLength;
    if (size > 1_000_000) throw new HttpFailure(413, "request body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
};

const headersFromIncoming = (request: http.IncomingMessage): Headers => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }
  return headers;
};

const webRequestFromIncoming = async (
  request: http.IncomingMessage,
  url: URL,
): Promise<Request> => {
  const method = request.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  const body = hasBody ? await readRawBody(request) : undefined;
  return new Request(url, {
    method,
    headers: headersFromIncoming(request),
    ...(body === undefined
      ? {}
      : {
          body: body.buffer.slice(
            body.byteOffset,
            body.byteOffset + body.byteLength,
          ) as ArrayBuffer,
        }),
  });
};

const writeWebResponse = async (
  response: http.ServerResponse,
  webResponse: Response,
): Promise<void> => {
  const headers: Record<string, string> = {};
  webResponse.headers.forEach((value, name) => {
    headers[name] = value;
  });
  response.writeHead(webResponse.status, headers);
  response.end(Buffer.from(await webResponse.arrayBuffer()));
};

const commandInputRecord = (input: unknown, label: string): Readonly<Record<string, unknown>> => {
  if (!isPlainRecord(input)) throw new HttpFailure(400, `invalid ${label} command input`);
  return input;
};

const invokeLocalAgentCommand = async (
  app: LocalAgentApp,
  request: CommandRequest,
): Promise<unknown> => {
  const { name, input } = request;
  if (name === WORKSPACE_AGENT_COMMAND.SUBMIT) {
    const record = commandInputRecord(input, "submit");
    return app.runtime.submit(assertSubmitRunInput(record.input, "submit"));
  }
  if (name === PRODUCT_COMMAND.SUBMIT_SESSION_TURN) {
    if (app.sessions === undefined) throw new HttpFailure(501, "sessions are unavailable");
    const record = commandInputRecord(input, "submitSessionTurn");
    assertSubmitRunInput(record, "submitSessionTurn");
    requireStringField(record, "sessionRef", "invalid session turn identity");
    requireStringField(record, "turnRef", "invalid session turn identity");
    return app.sessions.submitTurn(record);
  }
  if (name === PRODUCT_COMMAND.INSPECT_SESSION) {
    if (app.sessions === undefined) throw new HttpFailure(501, "sessions are unavailable");
    const record = commandInputRecord(input, "inspectSession");
    return app.sessions.inspect(requireStringField(record, "sessionRef", "invalid sessionRef"));
  }
  if (name === PRODUCT_COMMAND.LIST_SESSIONS) {
    if (app.sessions === undefined) throw new HttpFailure(501, "sessions are unavailable");
    return app.sessions.list();
  }
  if (name === PRODUCT_COMMAND.RUN_WORKFLOW) {
    if (app.workflows === undefined) throw new HttpFailure(501, "workflows are unavailable");
    const record = commandInputRecord(input, "runWorkflow");
    assertSubmitRunInput(record, "runWorkflow");
    requireStringField(record, "workflowId", "invalid workflow run identity");
    requireStringField(record, "workflowRunId", "invalid workflow run identity");
    return app.workflows.run(record);
  }
  if (name === PRODUCT_COMMAND.INSPECT_WORKFLOW_RUN) {
    if (app.workflows === undefined) throw new HttpFailure(501, "workflows are unavailable");
    const record = commandInputRecord(input, "inspectWorkflowRun");
    return app.workflows.inspectRun(
      requireStringField(record, "workflowId", "invalid workflow run identity"),
      requireStringField(record, "workflowRunId", "invalid workflow run identity"),
    );
  }
  if (name === PRODUCT_COMMAND.LIST_WORKFLOW_RUNS) {
    if (app.workflows === undefined) throw new HttpFailure(501, "workflows are unavailable");
    const record = commandInputRecord(input, "listWorkflowRuns");
    return app.workflows.listRuns(requireStringField(record, "workflowId", "invalid workflowId"));
  }
  if (name === WORKSPACE_AGENT_COMMAND.CUSTOM) {
    if (app.customCommand === undefined) {
      throw new HttpFailure(501, "custom commands are unavailable");
    }
    return app.customCommand(input);
  }
  throw new HttpFailure(501, `unsupported generated app command ${name}`);
};

const localAppOptionsFor = (args: ServeArgs): Readonly<Record<string, unknown>> => ({
  cwd: path.resolve(args.cwd),
  inheritEnv: true,
  ...(args.llm === "test"
    ? {
        llm: {
          kind: "test",
          responses: [
            {
              items: [{ type: "message", text: args.llmResponse }],
              usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            },
          ],
        },
      }
    : {}),
});

const loadGeneratedLocalApp = async (
  args: ServeArgs,
  facts: CompileFacts,
): Promise<LocalAgentApp> => {
  if (facts.normalized.target.kind !== "node@1") {
    throw new Error(
      `agentos serve requires target kind node@1; observed ${facts.normalized.target.kind}`,
    );
  }
  await writeGeneratedFiles(facts.cwd, facts.linked.files);
  const generatedLocal = path.join(facts.cwd, ".agentos", "generated", "local.ts");
  const mod = (await importBundledModule(generatedLocal, {
    prefix: "agentos-generated-local-app-",
    tempRoot: path.join(facts.cwd, ".agentos", ".cache"),
  })) as GeneratedLocalModule;
  if (typeof mod.createLocalAgentApp !== "function") {
    throw new Error(".agentos/generated/local.ts must export createLocalAgentApp");
  }
  return mod.createLocalAgentApp(localAppOptionsFor(args));
};

const parseAfterId = (url: URL): number | undefined => {
  const value = url.searchParams.get("afterId");
  if (value === null || value.length === 0) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new HttpFailure(400, "afterId must be a non-negative integer");
  }
  return parsed;
};

const writeSseEvents = (response: http.ServerResponse, events: ReadonlyArray<unknown>): void => {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const event of events) {
    response.write(`event: ledger\ndata: ${JSON.stringify(event)}\n\n`);
  }
  response.end();
};

interface StartedGeneratedAppServer {
  readonly payload: Readonly<{
    status: "listening";
    protocol: "agentos-local-app@1";
    mode: "serve" | "dev";
    target: string;
    llm: "config" | "test";
    url: string;
    endpoints: Readonly<{
      health: string;
      command: string;
      events: string;
    }>;
  }>;
  readonly close: () => Promise<void>;
}

const startGeneratedAppServer = async (
  command: "serve" | "dev",
  args: ServeArgs,
): Promise<StartedGeneratedAppServer> => {
  const facts = await loadCompileFacts(args);
  const app = await loadGeneratedLocalApp(args, facts);
  const server = http.createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (request.method === "GET" && url.pathname === "/agentos/health") {
        jsonResponse(response, 200, {
          ok: true,
          protocol: "agentos-local-app@1",
          mode: command,
          target: facts.normalized.target.kind,
          llm: args.llm,
          diagnostics: app.runtime.diagnostics(),
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/agentos/command") {
        const body = await readJsonBody(request);
        const result = await invokeLocalAgentCommand(app, commandRequestFromUnknown(body));
        jsonResponse(response, 200, { ok: true, value: result });
        return;
      }
      if (request.method === "GET" && url.pathname === "/agentos/events") {
        writeSseEvents(response, app.runtime.events({ afterId: parseAfterId(url) }));
        return;
      }
      if (url.pathname.startsWith("/channels/")) {
        if (app.channels === undefined) {
          throw new HttpFailure(501, "channels are unavailable");
        }
        const channelResponse = await app.channels.handle(
          await webRequestFromIncoming(request, url),
        );
        if (channelResponse === null) {
          notFound(response);
          return;
        }
        await writeWebResponse(response, channelResponse);
        return;
      }
      notFound(response);
    })().catch((error: unknown) => {
      errorResponse(response, error);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(args.port, args.host, () => resolve());
  });

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : args.port;
  const url = `http://${args.host}:${port}`;
  const payload = {
    status: "listening" as const,
    protocol: "agentos-local-app@1" as const,
    mode: command,
    target: facts.normalized.target.kind,
    llm: args.llm,
    url,
    endpoints: {
      health: `${url}/agentos/health`,
      command: `${url}/agentos/command`,
      events: `${url}/agentos/events`,
    },
  };
  return {
    payload,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
};

const serveGeneratedApp = async (command: "serve" | "dev", args: ServeArgs): Promise<void> => {
  const started = await startGeneratedAppServer(command, args);
  process.stdout.write(
    args.json
      ? `${JSON.stringify(started.payload)}\n`
      : `agentOS ${command} listening on ${started.payload.url} (${started.payload.protocol}, llm=${args.llm})\n`,
  );

  await new Promise<void>((resolve) => {
    const close = () => {
      void started.close().finally(resolve);
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  });
};

type EvalDefinitionLike = EvalDefinition;
type EvalConfigLike = EvalConfig;

interface EvalHttpTarget {
  readonly kind: "local" | "remote";
  readonly baseUrl: string;
  readonly headers: Readonly<Record<string, string>>;
}

interface EvalEventQueryLike {
  readonly afterId?: number;
}

interface EvalCaseResult {
  readonly evalId: string;
  readonly caseId: string;
  readonly status: "passed" | "failed";
  readonly error?: string;
  readonly assertions: readonly EvalAssertionResult[];
  readonly observation: EvalObservationArtifact;
}

type EvalObservationStatus = "completed" | "waiting" | "failed";

type EvalAssertionLike = EvalAssertion;

interface EvalProjectionObservation {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: string;
}

interface EvalObservationForCheck extends EvalObservation {
  readonly usage: EvalJsonObject;
}

interface EvalObservationArtifact {
  readonly status?: EvalObservationStatus;
  readonly events: readonly EvalEventRecordLike[];
  readonly projections: Readonly<Record<string, EvalProjectionObservation>>;
  readonly usage: EvalJsonObject;
}

interface EvalAssertionResult {
  readonly kind: string;
  readonly name?: string;
  readonly status: "passed" | "failed";
  readonly message?: string;
}

type EvalEventRecordLike = EvalEventRecord;

const collectEvalFiles = async (directory: string): Promise<readonly string[]> => {
  if (!(await pathExists(directory))) return [];
  const files: string[] = [];
  const visit = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(target);
        continue;
      }
      if (entry.isFile() && /\.eval\.[cm]?[jt]sx?$/u.test(entry.name)) {
        files.push(target);
      }
    }
  };
  await visit(directory);
  return files.sort((left, right) => left.localeCompare(right));
};

const evalDefinitionsFromModule = (
  mod: Readonly<Record<string, unknown>>,
  file: string,
): readonly EvalDefinitionLike[] => {
  const values = Object.values(mod).flatMap((value): readonly unknown[] =>
    Array.isArray(value) ? value : [value],
  );
  const definitions = values.flatMap((value): readonly EvalDefinitionLike[] => {
    if (!isPlainRecord(value)) return [];
    try {
      return [parseEvalDefinition(value)];
    } catch (error) {
      throw new Error(
        `${path.relative(process.cwd(), file)} exports invalid eval declaration: ${errorMessage(error)}`,
      );
    }
  });
  if (definitions.length === 0) {
    throw new Error(`${path.relative(process.cwd(), file)} exports no defineEval declaration`);
  }
  return definitions;
};

const loadEvalDefinitions = async (
  cwd: string,
  files: readonly string[],
): Promise<readonly EvalDefinitionLike[]> => {
  const definitions: EvalDefinitionLike[] = [];
  for (const file of files) {
    const mod = (await importBundledModule(file, {
      define: { "import.meta.url": JSON.stringify(pathToFileURL(file).href) },
      prefix: "agentos-eval-file-",
      tempRoot: path.join(cwd, ".agentos", ".cache"),
    })) as Readonly<Record<string, unknown>>;
    definitions.push(...evalDefinitionsFromModule(mod, file));
  }
  return definitions;
};

const loadEvalConfig = async (cwd: string): Promise<EvalConfigLike> => {
  const configPath = path.join(cwd, "evals", "evals.config.ts");
  if (!(await pathExists(configPath))) return parseEvalConfig(undefined);
  const mod = (await importBundledModule(configPath, {
    define: { "import.meta.url": JSON.stringify(pathToFileURL(configPath).href) },
    prefix: "agentos-eval-config-",
    tempRoot: path.join(cwd, ".agentos", ".cache"),
  })) as Readonly<Record<string, unknown>>;
  const config = mod.default ?? mod.config;
  try {
    return parseEvalConfig(config);
  } catch (error) {
    throw new Error(
      `evals/evals.config.ts must export defineEvalConfig() as default or config: ${errorMessage(error)}`,
    );
  }
};

const targetFromArgs = (
  args: EvalArgs,
  config: EvalConfigLike,
  localUrl?: string,
): EvalHttpTarget => {
  const configuredTarget = config.target;
  const mode =
    args.target ?? (args.baseUrl !== undefined ? "remote" : configuredTarget?.kind) ?? "local";
  if (mode === "remote") {
    const baseUrl =
      args.baseUrl ?? (configuredTarget?.kind === "remote" ? configuredTarget.baseUrl : undefined);
    if (baseUrl === undefined) {
      throw new Error("agentos eval: remote target requires --base-url or evals.config.ts target");
    }
    return {
      kind: "remote",
      baseUrl,
      headers: Object.freeze({
        ...(configuredTarget?.kind === "remote" ? (configuredTarget.headers ?? {}) : {}),
        ...args.headers,
      }),
    };
  }
  if (localUrl === undefined) {
    throw new Error("agentos eval: local target did not start");
  }
  return {
    kind: "local",
    baseUrl: localUrl,
    headers: Object.freeze({ ...args.headers }),
  };
};

const parseJsonOrText = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (text.length === 0) return null;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("json")) return JSON.parse(text);
  return text;
};

const parseSseJsonEvents = (text: string): readonly unknown[] =>
  text.split(/\n\n/u).flatMap((chunk) =>
    chunk
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice("data: ".length))),
  );

const evalEventRecordFromUnknown = (value: unknown): EvalEventRecordLike => {
  if (!isPlainRecord(value) || typeof value.kind !== "string") {
    throw new Error("/agentos/events emitted a non-event record");
  }
  if (typeof value.id !== "number" || !Number.isInteger(value.id) || value.id <= 0) {
    throw new Error(`/agentos/events emitted id-less event ${value.kind}`);
  }
  return Object.freeze({
    id: value.id,
    kind: value.kind,
    ...(Object.hasOwn(value, "payload") ? { payload: value.payload } : {}),
    ...(typeof value.timestamp === "string" ? { timestamp: value.timestamp } : {}),
  });
};

const responseHeaders = (headers: Headers): Readonly<Record<string, string>> => {
  const output: Record<string, string> = {};
  headers.forEach((value, name) => {
    output[name] = value;
  });
  return Object.freeze(output);
};

const headersRecord = (headers: HeadersInit | undefined): Readonly<Record<string, string>> => {
  const output: Record<string, string> = {};
  new Headers(headers).forEach((value, name) => {
    output[name] = value;
  });
  return output;
};

const jsonFetch = async (
  target: EvalHttpTarget,
  pathName: string,
  init: RequestInit = {},
): Promise<unknown> => {
  const response = await fetch(new URL(pathName, target.baseUrl), {
    ...init,
    headers: {
      ...target.headers,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...headersRecord(init.headers),
    },
  });
  const body = await parseJsonOrText(response);
  if (!response.ok) {
    const detail = isPlainRecord(body) && isPlainRecord(body.error) ? body.error.message : body;
    throw new Error(`HTTP ${response.status} ${pathName}: ${String(detail)}`);
  }
  return body;
};

const commandValue = async (
  target: EvalHttpTarget,
  name: string,
  input?: unknown,
): Promise<unknown> => {
  const body = await jsonFetch(target, "/agentos/command", {
    method: "POST",
    body: JSON.stringify({ name, input }),
  });
  if (!isPlainRecord(body) || body.ok !== true) {
    throw new Error(`agentos command ${name} returned invalid response`);
  }
  return body.value;
};

const eventQueryParams = (query: EvalEventQueryLike | undefined): string => {
  if (query?.afterId === undefined) return "";
  return `?afterId=${encodeURIComponent(String(query.afterId))}`;
};

const createEvalFacades = (target: EvalHttpTarget) => {
  const events = async (query?: EvalEventQueryLike) => {
    const response = await fetch(
      new URL(`/agentos/events${eventQueryParams(query)}`, target.baseUrl),
      {
        headers: target.headers,
      },
    );
    if (!response.ok) throw new Error(`HTTP ${response.status} /agentos/events`);
    return parseSseJsonEvents(await response.text()).map(evalEventRecordFromUnknown);
  };
  const sessions = {
    submitTurn: (input: unknown) => commandValue(target, "submitSessionTurn", input),
    inspect: (sessionRef: string) => commandValue(target, "inspectSession", { sessionRef }),
    list: () => commandValue(target, "listSessions"),
    command: (name: string, input?: unknown) => commandValue(target, name, input),
    events,
    projection: (name: string, input?: unknown) => commandValue(target, name, input),
  };
  const workflows = {
    run: (input: unknown) => commandValue(target, "runWorkflow", input),
    inspectRun: (workflowId: string, workflowRunId: string) =>
      commandValue(target, "inspectWorkflowRun", { workflowId, workflowRunId }),
    listRuns: (workflowId: string) => commandValue(target, "listWorkflowRuns", { workflowId }),
    start: (name: string, input?: unknown) =>
      commandValue(target, "runWorkflow", {
        workflowId: name,
        ...(isPlainRecord(input) ? input : { input }),
      }),
    inspect: (workflowRef: string) =>
      commandValue(target, "inspectWorkflowRun", { workflowRunId: workflowRef }),
  };
  const channels = {
    request: async (input: {
      readonly method?: string;
      readonly path: string;
      readonly headers?: Readonly<Record<string, string>>;
      readonly body?: unknown;
    }) => {
      const response = await fetch(new URL(input.path, target.baseUrl), {
        method: input.method ?? "POST",
        headers: {
          ...target.headers,
          ...(input.body === undefined ? {} : { "content-type": "application/json" }),
          ...(input.headers ?? {}),
        },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      });
      return Object.freeze({
        status: response.status,
        headers: responseHeaders(response.headers),
        body: await parseJsonOrText(response),
      });
    },
    dispatch: async (channel: string, payload: unknown) => {
      const response = await channels.request({
        method: "POST",
        path: `/channels/${channel}`,
        body: payload,
      });
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`channel ${channel} returned HTTP ${response.status}`);
      }
      return response.body;
    },
  };
  return Object.freeze({
    sessions,
    workflows,
    channels,
  });
};

const assertionProjectionNames = (assertions: readonly EvalAssertionLike[]): readonly string[] =>
  [
    ...new Set(
      assertions
        .filter(
          (assertion): assertion is Extract<EvalAssertionLike, { readonly kind: "projection" }> =>
            assertion.kind === "projection",
        )
        .map((assertion) => assertion.name),
    ),
  ].sort((left, right) => left.localeCompare(right));

const projectionObservationsForAssertions = async (
  target: EvalHttpTarget,
  assertions: readonly EvalAssertionLike[],
): Promise<Readonly<Record<string, EvalProjectionObservation>>> => {
  const projections: Record<string, EvalProjectionObservation> = {};
  for (const name of assertionProjectionNames(assertions)) {
    try {
      projections[name] = Object.freeze({ ok: true, value: await commandValue(target, name) });
    } catch (error) {
      projections[name] = Object.freeze({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return Object.freeze(projections);
};

const completedEventKinds = new Set(["agent.run.completed", "runtime.completed_after_tools"]);
const waitingEventKinds = new Set(["agent.run.interrupted", "agent.run.input_request"]);
const toolEventKinds = new Set(["tool.executed", "tool.rejected"]);

const eventPayload = (event: EvalEventRecordLike): Readonly<Record<string, unknown>> =>
  isPlainRecord(event.payload) ? event.payload : {};

const isEvalJsonValue = (value: unknown): value is EvalJsonValue => {
  if (value === null) return true;
  if (["boolean", "number", "string"].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isEvalJsonValue);
  return isPlainRecord(value) && Object.values(value).every(isEvalJsonValue);
};

const statusFromEvents = (
  events: readonly EvalEventRecordLike[],
): EvalObservationStatus | undefined => {
  let status: EvalObservationStatus | undefined;
  for (const event of events) {
    if (completedEventKinds.has(event.kind)) {
      status = "completed";
      continue;
    }
    if (waitingEventKinds.has(event.kind)) {
      status = "waiting";
      continue;
    }
    if (event.kind.startsWith("agent.aborted.") || event.kind.endsWith(".failed")) {
      status = "failed";
    }
  }
  return status;
};

const usageFromEvents = (events: readonly EvalEventRecordLike[]): EvalJsonObject => {
  let tokensUsed = 0;
  let hasTokensUsed = false;
  let llmUsage: EvalJsonValue | undefined;
  for (const event of events) {
    const payload = eventPayload(event);
    if (typeof payload.tokensUsed === "number") {
      tokensUsed += payload.tokensUsed;
      hasTokensUsed = true;
    }
    if (isEvalJsonValue(payload.usage)) {
      llmUsage = payload.usage;
    }
  }
  const usage: Record<string, EvalJsonValue> = {};
  if (hasTokensUsed) usage.tokensUsed = tokensUsed;
  if (llmUsage !== undefined) usage.llmUsage = llmUsage;
  return Object.freeze(usage);
};

const calledToolNames = (events: readonly EvalEventRecordLike[]): ReadonlySet<string> => {
  const names = new Set<string>();
  for (const event of events) {
    if (!toolEventKinds.has(event.kind)) continue;
    const payload = eventPayload(event);
    const name = payload.name ?? payload.toolName;
    if (typeof name === "string") names.add(name);
  }
  return names;
};

const failureReasonTokens = (
  events: readonly EvalEventRecordLike[],
  runError: unknown,
): ReadonlySet<string> => {
  const reasons = new Set<string>();
  if (runError instanceof Error) reasons.add(runError.message);
  for (const event of events) {
    if (!(event.kind.startsWith("agent.aborted.") || event.kind.endsWith(".failed"))) continue;
    reasons.add(event.kind);
    const payload = eventPayload(event);
    for (const key of ["reason", "code", "publicMessage"]) {
      const value = payload[key];
      if (typeof value === "string") reasons.add(value);
    }
  }
  return reasons;
};

const checkObservationFromArtifact = (
  observation: EvalObservationArtifact,
): EvalObservationForCheck => {
  const projections = new Map<string, unknown>();
  for (const [name, result] of Object.entries(observation.projections)) {
    if (result.ok) projections.set(name, result.value);
  }
  return Object.freeze({
    status: observation.status,
    events: observation.events,
    projections,
    usage: observation.usage,
  });
};

const assertionResult = (
  assertion: EvalAssertionLike,
  status: "passed" | "failed",
  message?: string,
): EvalAssertionResult => {
  const name =
    assertion.kind === "called_tool" || assertion.kind === "not_called_tool"
      ? assertion.toolName
      : assertion.kind === "projection" || assertion.kind === "check"
        ? assertion.name
        : assertion.kind === "failed"
          ? assertion.reason
          : undefined;
  return Object.freeze({
    kind: assertion.kind,
    ...(name === undefined ? {} : { name }),
    status,
    ...(message === undefined ? {} : { message }),
  });
};

const evaluateEvalAssertion = async (
  assertion: EvalAssertionLike,
  observation: EvalObservationArtifact,
  runError: unknown,
): Promise<EvalAssertionResult> => {
  switch (assertion.kind) {
    case "completed":
      return observation.status === "completed"
        ? assertionResult(assertion, "passed")
        : assertionResult(
            assertion,
            "failed",
            `expected completed, observed ${observation.status ?? "unknown"}`,
          );
    case "waiting":
      return observation.status === "waiting"
        ? assertionResult(assertion, "passed")
        : assertionResult(
            assertion,
            "failed",
            `expected waiting, observed ${observation.status ?? "unknown"}`,
          );
    case "failed": {
      if (observation.status !== "failed") {
        return assertionResult(
          assertion,
          "failed",
          `expected failed, observed ${observation.status ?? "unknown"}`,
        );
      }
      if (
        assertion.reason !== undefined &&
        !failureReasonTokens(observation.events, runError).has(assertion.reason)
      ) {
        return assertionResult(assertion, "failed", `missing failure reason ${assertion.reason}`);
      }
      return assertionResult(assertion, "passed");
    }
    case "called_tool": {
      const tools = calledToolNames(observation.events);
      return tools.has(assertion.toolName)
        ? assertionResult(assertion, "passed")
        : assertionResult(assertion, "failed", `missing tool call ${assertion.toolName}`);
    }
    case "not_called_tool": {
      const tools = calledToolNames(observation.events);
      return tools.has(assertion.toolName)
        ? assertionResult(assertion, "failed", `unexpected tool call ${assertion.toolName}`)
        : assertionResult(assertion, "passed");
    }
    case "used_no_tools": {
      const tools = calledToolNames(observation.events);
      return tools.size === 0
        ? assertionResult(assertion, "passed")
        : assertionResult(
            assertion,
            "failed",
            `observed tool calls: ${[...tools].sort().join(", ")}`,
          );
    }
    case "projection": {
      const projection = observation.projections[assertion.name];
      if (projection?.ok === true) return assertionResult(assertion, "passed");
      return assertionResult(
        assertion,
        "failed",
        projection?.error ?? `missing projection ${assertion.name}`,
      );
    }
    case "check": {
      try {
        const passed = await assertion.check(checkObservationFromArtifact(observation));
        return passed
          ? assertionResult(assertion, "passed")
          : assertionResult(assertion, "failed", "custom check returned false");
      } catch (error) {
        return assertionResult(
          assertion,
          "failed",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }
};

const collectEvalObservation = async (
  facades: ReturnType<typeof createEvalFacades>,
  target: EvalHttpTarget,
  assertions: readonly EvalAssertionLike[],
  runError: unknown,
  eventQuery?: EvalEventQueryLike,
): Promise<EvalObservationArtifact> => {
  const [rawEvents, projections] = await Promise.all([
    facades.sessions.events(eventQuery),
    projectionObservationsForAssertions(target, assertions),
  ]);
  const events = rawEvents;
  const observedStatus = statusFromEvents(events);
  return Object.freeze({
    status: observedStatus ?? (runError === undefined ? "completed" : "failed"),
    events: Object.freeze(events),
    projections,
    usage: usageFromEvents(events),
  });
};

const maxObservedEventId = (events: readonly EvalEventRecordLike[]): number => {
  let max = 0;
  for (const event of events) {
    if (event.id > max) {
      max = event.id;
    }
  }
  return max;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const runEvalDefinition = async (
  definition: EvalDefinitionLike,
  target: EvalHttpTarget,
): Promise<readonly EvalCaseResult[]> => {
  const facades = createEvalFacades(target);
  const results: EvalCaseResult[] = [];
  const assertions = definition.assertions ?? [];
  for (const testCase of definition.cases) {
    const afterId =
      definition.run === undefined
        ? undefined
        : maxObservedEventId(await facades.sessions.events());
    let runError: unknown;
    try {
      if (definition.run !== undefined) {
        const evalTarget: EvalTarget =
          target.kind === "remote"
            ? { kind: "remote", baseUrl: target.baseUrl, headers: target.headers }
            : { kind: "local" };
        await definition.run({
          case: testCase,
          target: evalTarget,
          t: facades,
          sessions: facades.sessions,
          workflows: facades.workflows,
          channels: facades.channels,
        });
      }
    } catch (error) {
      runError = error;
    }
    const observation = await collectEvalObservation(
      facades,
      target,
      assertions,
      runError,
      afterId === undefined ? undefined : { afterId },
    );
    const assertionResults = await Promise.all(
      assertions.map((assertion) => evaluateEvalAssertion(assertion, observation, runError)),
    );
    const failedAssertions = assertionResults.filter((result) => result.status === "failed");
    const failedStatusExpected = assertions.some((assertion) => assertion.kind === "failed");
    const passed =
      failedAssertions.length === 0 && (runError === undefined || failedStatusExpected);
    const messages = [
      ...(runError !== undefined && !failedStatusExpected ? [errorMessage(runError)] : []),
      ...failedAssertions.flatMap((result) =>
        result.message === undefined
          ? []
          : [
              `${result.kind}${result.name === undefined ? "" : `:${result.name}`}: ${result.message}`,
            ],
      ),
    ];
    results.push({
      evalId: definition.id,
      caseId: testCase.id,
      status: passed ? "passed" : "failed",
      ...(messages.length === 0 ? {} : { error: messages.join("; ") }),
      assertions: Object.freeze(assertionResults),
      observation,
    });
  }
  return results;
};

const writeEvalReportArtifact = async (
  cwd: string,
  report: Readonly<Record<string, unknown>>,
): Promise<string> => {
  const directory = path.join(cwd, ".agentos", "eval-results");
  await mkdir(directory, { recursive: true });
  const timestamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
  const file = path.join(directory, `${timestamp}.json`);
  const relative = path.relative(cwd, file).split(path.sep).join("/");
  await writeFile(file, `${JSON.stringify({ ...report, artifact: relative }, null, 2)}\n`);
  return relative;
};

const runEval = async (args: EvalArgs): Promise<void> => {
  const cwd = path.resolve(args.cwd);
  const evalFiles = await collectEvalFiles(path.join(cwd, "evals"));
  if (evalFiles.length === 0) {
    throw new Error("agentos eval: no evals/**/*.eval.ts files found");
  }
  const [config, definitions] = await Promise.all([
    loadEvalConfig(cwd),
    loadEvalDefinitions(cwd, evalFiles),
  ]);
  let started: StartedGeneratedAppServer | undefined;
  try {
    const configuredMode =
      args.target ?? (args.baseUrl !== undefined ? "remote" : config.target?.kind);
    if (configuredMode !== "remote") {
      started = await startGeneratedAppServer("serve", {
        cwd,
        config: args.config,
        ...(args.packageScope === undefined ? {} : { packageScope: args.packageScope }),
        host: "127.0.0.1",
        port: 0,
        llm: args.llm,
        llmResponse: args.llmResponse,
        json: true,
      });
    }
    const target = targetFromArgs(args, config, started?.payload.url);
    const results = [];
    for (const definition of definitions) {
      results.push(...(await runEvalDefinition(definition, target)));
    }
    const failed = results.filter((result) => result.status === "failed");
    const report = {
      ok: failed.length === 0,
      target: {
        kind: target.kind,
        ...(target.kind === "remote" ? { baseUrl: target.baseUrl } : {}),
      },
      files: evalFiles.map((file) => path.relative(cwd, file)),
      evals: definitions.map((definition) => definition.id),
      total: results.length,
      passed: results.length - failed.length,
      failed: failed.length,
      results,
    };
    const artifact = await writeEvalReportArtifact(cwd, report);
    const reportWithArtifact = { ...report, artifact };
    process.stdout.write(
      args.json
        ? `${JSON.stringify(reportWithArtifact, null, 2)}\n`
        : `agentOS eval ${report.ok ? "passed" : "failed"}: ${report.passed}/${report.total} (${artifact})\n`,
    );
    if (!report.ok) process.exitCode = 1;
  } finally {
    await started?.close();
  }
};

const printInfoHuman = (info: ReturnType<typeof projectInfo>): void => {
  const lines = [
    "agentOS info",
    `profile: ${info.compile.profile}`,
    `target: ${info.compile.target}`,
    `agent: ${info.compile.agent.id}`,
    `deployment: ${info.compile.deployment.id} (${info.compile.deployment.backend}/${info.compile.deployment.adapter})`,
    `generated files: ${info.compile.generated.files.length}`,
    `resolve: ${info.resolve.status} - ${info.resolve.reason}`,
    `runtime: ${info.runtime.status} - ${info.runtime.reason}`,
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
};

const main = async (): Promise<void> => {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.command === "help") {
    process.stdout.write(help);
    return;
  }
  if (parsed.command === "build") {
    const facts = await loadCompileFacts(parsed.args);
    await writeGeneratedFiles(facts.cwd, facts.linked.files);
    console.log(`generated ${facts.linked.files.length} agentOS files`);
    return;
  }
  if (parsed.command === "serve" || parsed.command === "dev") {
    await serveGeneratedApp(parsed.command, parsed.args);
    return;
  }
  if (parsed.command === "eval") {
    await runEval(parsed.args);
    return;
  }
  if (parsed.command === "preflight") {
    await runPreflightLlm(parsed.args);
    return;
  }
  const facts = await loadCompileFacts({ ...parsed.args, packageScope: undefined });
  const info = projectInfo(facts);
  if (parsed.args.json) {
    process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
  } else {
    printInfoHuman(info);
  }
};

try {
  await main();
} catch (error) {
  const command = process.argv[2];
  const prefix =
    command === "build"
      ? "agentos build"
      : command === "info"
        ? "agentos info"
        : command === "serve"
          ? "agentos serve"
          : command === "dev"
            ? "agentos dev"
            : command === "eval"
              ? "agentos eval"
              : command === "preflight"
                ? "agentos preflight"
                : "agentos";
  process.stderr.write(`${prefix}: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
