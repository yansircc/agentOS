#!/usr/bin/env node
import { fail } from "./support.mjs";
import { buildInternalPackages } from "./staging-build.mjs";
import { checkDistribution, packInternal } from "./pack-check.mjs";
import {
  consumerCheck,
  consumerStatus,
  installConsumer,
  restoreConsumer,
  testInternalConsumer,
} from "./consumer.mjs";
import { localRegistry, publishInternal, publishLocal } from "./publish-registry.mjs";

const command = process.argv[2] ?? "check";
const commandArgs = process.argv.slice(3);

switch (command) {
  case "build":
    buildInternalPackages();
    break;
  case "pack":
    packInternal();
    break;
  case "check":
    checkDistribution();
    break;
  case "test-consumer":
    testInternalConsumer();
    break;
  case "publish":
    publishInternal();
    break;
  case "publish-local":
    publishLocal(commandArgs);
    break;
  case "local-registry":
    localRegistry(commandArgs);
    break;
  case "install-consumer":
    installConsumer(commandArgs);
    break;
  case "consumer-status":
    consumerStatus(commandArgs);
    break;
  case "consumer-check":
    consumerCheck(commandArgs);
    break;
  case "restore-consumer":
    restoreConsumer(commandArgs);
    break;
  default:
    fail(`unknown distribution command: ${command}`);
}
