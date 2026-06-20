import { createRequire } from "node:module";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const sourceAuthoringUrl = new URL(
  "../../../../packages/composers/agent-authoring/src/index.ts",
  import.meta.url,
);

const parseArgs = (rawArgs) => {
  const args = {
    cwd: process.cwd(),
    config: "agentos.config.jsonc",
    packageScope: undefined,
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
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        throw new Error(`unexpected argument ${arg}`);
    }
  }
  return args;
};

const help = `Usage:
  agentos build [--cwd <path>] [--config <path>] [--package-scope <scope>]

Compiles agent/ + agentos.config.jsonc into .agentos/generated/.
`;

const stripJsonc = (text) => {
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

const removeTrailingCommas = (text) => {
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

const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));

const readJsonc = async (file) => {
  try {
    return JSON.parse(removeTrailingCommas(stripJsonc(await readFile(file, "utf8"))));
  } catch (error) {
    throw new Error(`${path.relative(process.cwd(), file)} is not valid JSONC: ${error.message}`);
  }
};

const pathExists = async (file) => {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
};

const toAuthoredPath = (cwd, file) => path.relative(cwd, file).split(path.sep).join("/");

const inferPackageScope = (config, explicitScope) => {
  if (explicitScope !== undefined) return explicitScope;
  const schema = typeof config.$schema === "string" ? config.$schema : "";
  const match = /(?:^|\/)node_modules\/(@[^/]+)\/config\/schema\.json$/u.exec(schema);
  return match?.[1];
};

const loadAuthoring = async (cwd, packageScope) => {
  const candidates = [];
  if (packageScope !== undefined) candidates.push(`${packageScope}/agent-authoring`);
  candidates.push("@agent-os/agent-authoring");

  const requireFromCwd = createRequire(path.join(cwd, "package.json"));
  for (const specifier of candidates) {
    let resolved;
    try {
      resolved = requireFromCwd.resolve(specifier);
    } catch {
      // Try the next package scope, then the source checkout fallback.
      continue;
    }
    return import(pathToFileURL(resolved).href);
  }
  return import(sourceAuthoringUrl.href);
};

const loadToolDeclaration = async (file) => {
  const mod = await import(`${pathToFileURL(file).href}?agentos-build=${Date.now()}`);
  if (!Object.hasOwn(mod, "declaration")) {
    throw new Error(`${file}: missing exported declaration`);
  }
  return mod.declaration;
};

const loadAuthoredTree = async (cwd, agentDir) => {
  const files = [
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

  return { files };
};

const writeGeneratedFiles = async (cwd, files) => {
  await rm(path.join(cwd, ".agentos", "generated"), { recursive: true, force: true });
  for (const file of files) {
    const output = path.join(cwd, file.path);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, file.text);
  }
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(help);
    return;
  }
  if (process.versions.bun === undefined) {
    throw new Error(
      "agentos build must run under Bun because authored tools are TypeScript modules",
    );
  }

  const cwd = path.resolve(args.cwd);
  const configPath = path.resolve(cwd, args.config);
  const configValue = await readJsonc(configPath);
  const packageScope = inferPackageScope(configValue, args.packageScope);
  const authoring = await loadAuthoring(cwd, packageScope);
  const decodedConfig = authoring.decodeAgentOsConfig(configValue);
  if (!decodedConfig.ok) {
    throw new Error(
      `agentos.config.jsonc invalid: ${JSON.stringify(decodedConfig.issues, null, 2)}`,
    );
  }

  const agentDir = path.resolve(cwd, decodedConfig.value.agent);
  const tree = await loadAuthoredTree(cwd, agentDir);
  const compiled = authoring.compileAgentTree(tree);
  if (!compiled.ok) {
    throw new Error(`agent tree invalid: ${JSON.stringify(compiled.issues, null, 2)}`);
  }

  const normalized = authoring.normalizeAgentOsConfig(decodedConfig.value, compiled.value);
  if (!normalized.ok) {
    throw new Error(
      `agentos config normalization failed: ${JSON.stringify(normalized.issues, null, 2)}`,
    );
  }

  const linked = authoring.linkWorkspaceStaticTarget(
    normalized.value,
    packageScope === undefined ? {} : { packageScope },
  );
  if (!linked.ok) {
    throw new Error(`static target link failed: ${JSON.stringify(linked.issues, null, 2)}`);
  }

  await writeGeneratedFiles(cwd, linked.value.files);
  console.log(`generated ${linked.value.files.length} agentOS files`);
};

try {
  await main();
} catch (error) {
  process.stderr.write(
    `agentos build: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
