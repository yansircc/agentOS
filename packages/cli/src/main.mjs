#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { bundleModuleForNode } from "./lib/ts-module-loader.mjs";
import {
  algorithmicCheckerAcceptsArgs,
  hasAlgorithmicChecker,
  runAlgorithmicChecker,
} from "./check/algorithmic-checks.mjs";
import {
  deriveAffectedGates,
  printAffectedGates,
  runAffectedGates,
} from "./check/gate-selector.mjs";
import { runDefaultGate } from "./check/default-gate.mjs";
import { listGuards, runGroup, runGuard } from "./runner.mjs";

const packageRootFromMain = () => path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const repoRootFromMain = () => path.dirname(path.dirname(packageRootFromMain()));

const readReleaseVersion = () => {
  const packageJson = JSON.parse(
    readFileSync(path.join(repoRootFromMain(), "package.json"), "utf8"),
  );
  const version = packageJson.agentOsRelease?.version;
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("package.json agentOsRelease.version must be a non-empty string");
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
  agentos check all
  agentos check default
  agentos check structural
  agentos check affected [--base <ref>] [--head <ref>] [--json] [--explain] [--run]
  agentos check docs
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
          reject(new Error(`agentos ${command}: build runner failed with exit code ${code ?? 1}`));
          return;
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

const runCheck = async (args) => {
  const [command, ...rest] = args;
  switch (command) {
    case "all":
      expectNoExtraArgs(rest, "agentos check all");
      await runGroup("all");
      return;
    case "default":
      expectNoExtraArgs(rest, "agentos check default");
      await runDefaultGate();
      return;
    case "structural":
      expectNoExtraArgs(rest, "agentos check structural");
      await runGroup("all");
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
      const result = deriveAffectedGates({ base, head });
      printAffectedGates(result, { json });
      if (run) runAffectedGates(result);
      return;
    }
    case "docs":
      expectNoExtraArgs(rest, "agentos check docs");
      await runGroup("check-docs");
      return;
    case "effect-manifests":
      expectNoExtraArgs(rest, "agentos check effect-manifests");
      await runGroup("check-effect-manifests");
      return;
    case "release":
      expectNoExtraArgs(rest, "agentos check release");
      await runGroup("release");
      return;
    case "site":
      expectNoExtraArgs(rest, "agentos check site");
      await runGroup("check-site");
      return;
    case "guard-coverage":
      expectNoExtraArgs(rest, "agentos check guard-coverage");
      await runGroup("guard-coverage");
      return;
    case "guard": {
      const [ruleId, ...extra] = rest;
      if (ruleId === undefined) throw new Error("agentos check guard: missing <rule-id>");
      expectNoExtraArgs(extra, "agentos check guard");
      await runGuard(ruleId);
      return;
    }
    case "guards":
      expectNoExtraArgs(rest, "agentos check guards");
      for (const id of listGuards()) console.log(id);
      return;
    default:
      if (command !== undefined && hasAlgorithmicChecker(command)) {
        if (!algorithmicCheckerAcceptsArgs(command)) {
          expectNoExtraArgs(rest, `agentos check ${command}`);
        }
        await runAlgorithmicChecker(command, rest);
        return;
      }
      throw new Error(
        "agentos check: choose one of all, default, structural, affected, docs, effect-manifests, release, site, guard-coverage, guard, guards, or an algorithmic checker id",
      );
  }
};

const runGenerate = async (args) => {
  const [command, ...rest] = args;
  switch (command) {
    case "docs":
      expectNoExtraArgs(rest, "agentos generate docs");
      await runGroup("generate-docs");
      return;
    case "effect-manifests":
      expectNoExtraArgs(rest, "agentos generate effect-manifests");
      await runGroup("generate-effect-manifests");
      return;
    case "site":
      if (rest[0] === "--watch") {
        expectNoExtraArgs(rest.slice(1), "agentos generate site --watch");
        await runGroup("generate-site-watch");
      } else {
        expectNoExtraArgs(rest, "agentos generate site");
        await runGroup("generate-site");
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
    case "check":
      await runCheck(rest);
      return;
    case "generate":
      await runGenerate(rest);
      return;
    default:
      throw new Error("agentos: choose one of build, info, serve, dev, check, generate");
  }
};

try {
  await main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
