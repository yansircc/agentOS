#!/usr/bin/env node
import { listGuards, runGroup, runGuard } from "./runner.mjs";

const usage = (message) => {
  if (message !== undefined) console.error(message);
  console.error("usage: agentos <check|generate> <target>");
  console.error("check targets: all, docs, effect-manifests, release, guard <rule-id>, guards");
  console.error("generate targets: docs, effect-manifests, site");
  process.exit(message === undefined ? 0 : 1);
};

const [command, target, extra] = process.argv.slice(2);

try {
  if (command === "generate") {
    if (target === "docs" && extra === undefined) runGroup("generate-docs");
    else if (target === "effect-manifests" && extra === undefined)
      runGroup("generate-effect-manifests");
    else if (target === "site" && extra === undefined) runGroup("generate-site");
    else usage(`unknown generate target: ${target ?? "<missing>"}`);
  } else if (command === "check") {
    if (target === "all" && extra === undefined) runGroup("all");
    else if (target === "docs" && extra === undefined) runGroup("check-docs");
    else if (target === "effect-manifests" && extra === undefined)
      runGroup("check-effect-manifests");
    else if (target === "release" && extra === undefined) runGroup("release");
    else if (target === "guard") {
      if (extra === undefined) usage("missing guard rule id");
      runGuard(extra);
    } else if (target === "guards" && extra === undefined) {
      for (const id of listGuards()) console.log(id);
    } else usage(`unknown check target: ${target ?? "<missing>"}`);
  } else {
    usage(command === undefined ? undefined : `unknown command: ${command}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
