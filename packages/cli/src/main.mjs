#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { bundleModuleForNode } from "./lib/ts-module-loader.mjs";
import {
  consumerCheck,
  consumerStatus,
  installConsumer,
  restoreConsumer,
} from "./consumer-overlay.mjs";
import { releaseStatus } from "./release-status.mjs";

const packageRootFromMain = () => path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const repoRootFromMain = () => path.dirname(path.dirname(packageRootFromMain()));

const readReleaseVersion = () => {
  const rootPackagePath = path.join(repoRootFromMain(), "package.json");
  const packagePath = existsSync(rootPackagePath)
    ? rootPackagePath
    : path.join(packageRootFromMain(), "package.json");
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  const version = packageJson.agentOsRelease?.version ?? packageJson.version;
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("package.json version must be a non-empty string");
  }
  return version;
};

const version = readReleaseVersion();

const helpText = `agentOS repository CLI ${version}

Usage:
  agentos --help
  agentos --version
  agentos build [--cwd <path>] [--config <path>] [--package-scope <scope>]
  agentos info [--cwd <path>] [--config <path>] [--json]
  agentos serve [--cwd <path>] [--config <path>] [--package-scope <scope>] [--host <host>] [--port <port>] [--llm config|test] [--llm-response <text>] [--json]
  agentos dev [--cwd <path>] [--config <path>] [--package-scope <scope>] [--host <host>] [--port <port>] [--llm config|test] [--llm-response <text>] [--json]
  agentos eval [--cwd <path>] [--config <path>] [--package-scope <scope>] [--target local|remote] [--base-url <url>] [--header <name=value>] [--llm config|test] [--llm-response <text>] [--json]
  agentos preflight llm [--cwd <path>] [--config <path>] [--route <binding-ref>] [--json]
  agentos release status [path/to/consumer] [--json] [--check-npm] [--registry <url>] [--install-manifest <path>]
  agentos consumer install /path/to/consumer [--from-manifest <path>] [--no-install] [--skip-pack] [--json]
  agentos consumer status /path/to/consumer [--json] [--check-npm] [--registry <url>]
  agentos consumer check /path/to/consumer [--json] [--check-npm] [--registry <url>]
  agentos consumer restore /path/to/consumer [--no-install] [--json]
  agentos check all
  agentos check default
  agentos check structural
  agentos check affected [--base <ref>] [--head <ref>] [--json] [--explain] [--run]
  agentos check docs
  agentos check effect-scan [--repo <path>] [--evidence <path>] [--scanner <command>]
  agentos check effect-manifests
  agentos check release
  agentos check site
  agentos check guard-coverage
  agentos check <algorithmic-check-id>
  agentos check guard <rule-id>
  agentos check guards
  agentos generate docs
  agentos generate effect-manifests
  agentos generate site
  agentos generate site --watch
`;

const printHelp = () => {
  process.stdout.write(helpText);
};

const fail = (message) => {
  process.stderr.write(`${message}\n\n`);
  if (
    message.startsWith("agentos:") ||
    message.startsWith("agentos build:") ||
    message.startsWith("agentos info:") ||
    message.startsWith("agentos serve:") ||
    message.startsWith("agentos dev:") ||
    message.startsWith("agentos eval:") ||
    message.startsWith("agentos preflight:") ||
    message.startsWith("agentos release:") ||
    message.startsWith("agentos consumer:") ||
    message.startsWith("agentos check:") ||
    message.startsWith("agentos generate:")
  ) {
    printHelp();
  }
  process.exitCode = 1;
};

const expectNoExtraArgs = (args, command) => {
  if (args.length > 0) {
    throw new Error(`${command}: unexpected argument ${args.join(" ")}`);
  }
};

const isHelpCommand = (command) =>
  command === undefined || command === "--help" || command === "-h";

const runBuildRunner = async (command, args) => {
  const runner = fileURLToPath(new URL("./build/build-cli.ts", import.meta.url));
  const bundled = await bundleModuleForNode(runner, {
    prefix: "agentos-build-runner-",
    tempRoot: path.join(packageRootFromMain(), "node_modules", ".cache", "agentos-build"),
  });
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [bundled.outfile, command, ...args], {
        stdio: "inherit",
      });
      child.on("error", (error) => {
        reject(
          new Error(`agentos ${command}: failed to start node build runner: ${error.message}`),
        );
      });
      child.on("exit", (code, signal) => {
        if (signal !== null) {
          reject(new Error(`agentos ${command}: build runner terminated by ${signal}`));
          return;
        }
        if (code !== 0) {
          process.exitCode = code ?? 1;
        }
        resolve();
      });
    });
  } finally {
    await bundled.cleanup();
  }
};

const runBuild = async (args) => runBuildRunner("build", args);

const runInfo = async (args) => runBuildRunner("info", args);

const runServe = async (args) => runBuildRunner("serve", args);

const runDev = async (args) => runBuildRunner("dev", args);

const runEval = async (args) => runBuildRunner("eval", args);

const runPreflight = async (args) => runBuildRunner("preflight", args);

const loadRunner = () => import("./runner.mjs");

const runCheckGroup = async (group) => {
  const { runGroup } = await loadRunner();
  await runGroup(group);
};

const loadAlgorithmicChecks = () => import("./check/algorithmic-checks.mjs");

const loadGateSelector = () => import("./check/gate-selector.mjs");

const loadDefaultGate = () => import("./check/default-gate.mjs");

const loadEffectScanGate = () => import("./check/effect-scan-gate.mjs");

const sourceConsumerProducer = () => {
  const modulePath = path.join(repoRootFromMain(), "tooling/distribution/pack-check.mjs");
  const supportPath = path.join(repoRootFromMain(), "tooling/distribution/support.mjs");
  if (!existsSync(modulePath) || !existsSync(supportPath)) return undefined;
  return {
    sourceRoot: repoRootFromMain(),
    defaultInstallManifestPath: path.join(
      repoRootFromMain(),
      "dist/internal-npm/install-manifest.json",
    ),
    produceInstallManifest: async () => {
      const producer = await import(pathToFileURL(modulePath).href);
      producer.packInternal();
      return path.join(repoRootFromMain(), "dist/internal-npm/install-manifest.json");
    },
  };
};

const runConsumer = async (args) => {
  const [command, ...rest] = args;
  if (isHelpCommand(command)) {
    printHelp();
    return;
  }
  const commandArgs = rest[0] === "--" ? rest.slice(1) : rest;
  const sourceContext = sourceConsumerProducer() ?? {};
  const context = { packageRoot: packageRootFromMain(), ...sourceContext };
  switch (command) {
    case "install":
      await installConsumer(commandArgs, context);
      return;
    case "status":
      consumerStatus(commandArgs, context);
      return;
    case "check":
      consumerCheck(commandArgs, context);
      return;
    case "restore":
      restoreConsumer(commandArgs, context);
      return;
    default:
      throw new Error("agentos consumer: choose one of install, status, check, restore");
  }
};

const runRelease = async (args) => {
  const [command, ...rest] = args;
  if (isHelpCommand(command)) {
    printHelp();
    return;
  }
  const commandArgs = rest[0] === "--" ? rest.slice(1) : rest;
  const sourceContext = sourceConsumerProducer() ?? {};
  const context = { packageRoot: packageRootFromMain(), ...sourceContext };
  switch (command) {
    case "status":
      releaseStatus(commandArgs, context);
      return;
    default:
      throw new Error("agentos release: choose status");
  }
};

const runCheck = async (args) => {
  const [command, ...rest] = args;
  if (isHelpCommand(command)) {
    printHelp();
    return;
  }
  switch (command) {
    case "all":
      expectNoExtraArgs(rest, "agentos check all");
      await runCheckGroup("all");
      return;
    case "default":
      expectNoExtraArgs(rest, "agentos check default");
      {
        const { runDefaultGate } = await loadDefaultGate();
        await runDefaultGate();
      }
      return;
    case "structural":
      expectNoExtraArgs(rest, "agentos check structural");
      await runCheckGroup("all");
      return;
    case "affected": {
      let base;
      let head;
      let json = false;
      let run = false;
      for (let index = 0; index < rest.length; index += 1) {
        const arg = rest[index];
        if (arg === "--base") {
          base = rest[index + 1];
          if (base === undefined) throw new Error("agentos check affected: --base requires a ref");
          index += 1;
        } else if (arg === "--head") {
          head = rest[index + 1];
          if (head === undefined) throw new Error("agentos check affected: --head requires a ref");
          index += 1;
        } else if (arg === "--json") {
          json = true;
        } else if (arg === "--explain") {
          json = false;
        } else if (arg === "--run") {
          run = true;
        } else {
          throw new Error(`agentos check affected: unexpected argument ${arg}`);
        }
      }
      const { deriveAffectedGates, printAffectedGates, runAffectedGates } =
        await loadGateSelector();
      const result = deriveAffectedGates({ base, head });
      printAffectedGates(result, { json });
      if (run) runAffectedGates(result);
      return;
    }
    case "docs":
      expectNoExtraArgs(rest, "agentos check docs");
      await runCheckGroup("check-docs");
      return;
    case "effect-scan":
      {
        const { runEffectScanGate } = await loadEffectScanGate();
        runEffectScanGate(rest, { defaultRepoRoot: repoRootFromMain() });
      }
      return;
    case "effect-manifests":
      expectNoExtraArgs(rest, "agentos check effect-manifests");
      await runCheckGroup("check-effect-manifests");
      return;
    case "release":
      expectNoExtraArgs(rest, "agentos check release");
      await runCheckGroup("release");
      return;
    case "site":
      expectNoExtraArgs(rest, "agentos check site");
      await runCheckGroup("check-site");
      return;
    case "guard-coverage":
      expectNoExtraArgs(rest, "agentos check guard-coverage");
      await runCheckGroup("guard-coverage");
      return;
    case "guard": {
      const [ruleId, ...extra] = rest;
      if (ruleId === undefined) throw new Error("agentos check guard: missing <rule-id>");
      expectNoExtraArgs(extra, "agentos check guard");
      const { runGuard } = await loadRunner();
      await runGuard(ruleId);
      return;
    }
    case "guards":
      expectNoExtraArgs(rest, "agentos check guards");
      {
        const { listGuards } = await loadRunner();
        for (const id of listGuards()) console.log(id);
      }
      return;
    default:
      {
        const { algorithmicCheckerAcceptsArgs, hasAlgorithmicChecker, runAlgorithmicChecker } =
          await loadAlgorithmicChecks();
        if (command !== undefined && hasAlgorithmicChecker(command)) {
          if (!algorithmicCheckerAcceptsArgs(command)) {
            expectNoExtraArgs(rest, `agentos check ${command}`);
          }
          await runAlgorithmicChecker(command, rest);
          return;
        }
      }
      throw new Error(
        "agentos check: choose one of all, default, structural, affected, docs, effect-scan, effect-manifests, release, site, guard-coverage, guard, guards, or an algorithmic checker id",
      );
  }
};

const runGenerate = async (args) => {
  const [command, ...rest] = args;
  if (isHelpCommand(command)) {
    printHelp();
    return;
  }
  switch (command) {
    case "docs":
      expectNoExtraArgs(rest, "agentos generate docs");
      await runCheckGroup("generate-docs");
      return;
    case "effect-manifests":
      expectNoExtraArgs(rest, "agentos generate effect-manifests");
      await runCheckGroup("generate-effect-manifests");
      return;
    case "site":
      if (rest[0] === "--watch") {
        expectNoExtraArgs(rest.slice(1), "agentos generate site --watch");
        await runCheckGroup("generate-site-watch");
      } else {
        expectNoExtraArgs(rest, "agentos generate site");
        await runCheckGroup("generate-site");
      }
      return;
    default:
      throw new Error("agentos generate: choose one of docs, effect-manifests, site");
  }
};

const main = async () => {
  const args = process.argv.slice(2);
  const [command, ...rest] = args;
  if (command === undefined || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command === "--version" || command === "-v") {
    console.log(version);
    return;
  }
  switch (command) {
    case "build":
      await runBuild(rest);
      return;
    case "info":
      await runInfo(rest);
      return;
    case "serve":
      await runServe(rest);
      return;
    case "dev":
      await runDev(rest);
      return;
    case "eval":
      await runEval(rest);
      return;
    case "preflight":
      await runPreflight(rest);
      return;
    case "release":
      await runRelease(rest);
      return;
    case "consumer":
      await runConsumer(rest);
      return;
    case "check":
      await runCheck(rest);
      return;
    case "generate":
      await runGenerate(rest);
      return;
    default:
      throw new Error(
        "agentos: choose one of build, info, serve, dev, eval, preflight, release, consumer, check, generate",
      );
  }
};

try {
  await main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
