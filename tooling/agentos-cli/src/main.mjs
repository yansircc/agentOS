#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { hasAlgorithmicChecker, runAlgorithmicChecker } from "./check/algorithmic-checks.mjs";
import { listGuards, runGroup, runGuard } from "./runner.mjs";

const version = "0.5.16";

const helpText = `agentOS repository CLI ${version}

Usage:
  agentos --help
  agentos --version
  agentos build [--cwd <path>] [--config <path>] [--package-scope <scope>]
  agentos check all
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

const runBuild = async (args) => {
  const runner = fileURLToPath(
    new URL("../../../packages/composers/agent-authoring/bin/build-cli.ts", import.meta.url),
  );
  await new Promise((resolve, reject) => {
    const child = spawn("bun", [runner, "build", ...args], { stdio: "inherit" });
    child.on("error", (error) => {
      reject(new Error(`agentos build: failed to start bun: ${error.message}`));
    });
    child.on("exit", (code, signal) => {
      if (signal !== null) {
        reject(new Error(`agentos build: build runner terminated by ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`agentos build: build runner failed with exit code ${code ?? 1}`));
        return;
      }
      resolve();
    });
  });
};

const runCheck = async (args) => {
  const [command, ...rest] = args;
  switch (command) {
    case "all":
      expectNoExtraArgs(rest, "agentos check all");
      await runGroup("all");
      return;
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
        expectNoExtraArgs(rest, `agentos check ${command}`);
        await runAlgorithmicChecker(command);
        return;
      }
      throw new Error(
        "agentos check: choose one of all, docs, effect-manifests, release, site, guard-coverage, guard, guards, or an algorithmic checker id",
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
    case "check":
      await runCheck(rest);
      return;
    case "generate":
      await runGenerate(rest);
      return;
    default:
      throw new Error("agentos: choose one of build, check, generate");
  }
};

try {
  await main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
