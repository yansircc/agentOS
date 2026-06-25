#!/usr/bin/env node

import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  compileAgentTree,
  decodeAgentOsConfig,
  linkWorkspaceStaticTarget,
  normalizeAgentOsConfig,
  type AuthoredAgentTree,
  type AuthoredToolDeclaration,
  type NormalizedAgentOsConfig,
  type StaticTargetLink,
} from "./agent-authoring";
import { importBundledModule } from "../lib/ts-module-loader.mjs";

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

type CliArgs =
  | { readonly command: "help" }
  | { readonly command: "build"; readonly args: BuildArgs }
  | { readonly command: "info"; readonly args: InfoArgs };

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

const parseArgs = (rawArgs: ReadonlyArray<string>): CliArgs => {
  const [command, ...rest] = rawArgs;
  if (command === undefined || command === "--help" || command === "-h") return { command: "help" };
  if (rest.includes("--help") || rest.includes("-h")) return { command: "help" };
  if (command === "build") return { command: "build", args: parseBuildArgs(rest) };
  if (command === "info") return { command: "info", args: parseInfoArgs(rest) };
  throw new Error("choose one of build, info");
};

const help = `Usage:
  agentos build [--cwd <path>] [--config <path>] [--package-scope <scope>]
  agentos info [--cwd <path>] [--config <path>] [--json]

Compiles agent/ + agentos.config.jsonc into .agentos/generated/.
Prints compile-only agent inspection without starting a runtime.
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

  const toolsDir = path.join(agentDir, "tools");
  if (await pathExists(toolsDir)) {
    const toolFiles = (await readdir(toolsDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => path.join(toolsDir, entry.name))
      .sort((left, right) => left.localeCompare(right));
    for (const file of toolFiles) {
      files.push({
        path: toAuthoredPath(cwd, file),
        kind: "tool",
        declaration: await loadToolDeclaration(file),
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

  const skillsDir = path.join(agentDir, "skills");
  if (await pathExists(skillsDir)) {
    for (const file of await collectFiles(skillsDir)) {
      const authoredPath = toAuthoredPath(cwd, file.path);
      const relativeSkillPath = path.relative(skillsDir, file.path);
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
    command === "build" ? "agentos build" : command === "info" ? "agentos info" : "agentos";
  process.stderr.write(`${prefix}: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
