#!/usr/bin/env node
import { Args, Command } from "@effect/cli";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Console, Effect } from "effect";
import { listGuards, runGroup, runGuard } from "./runner.mjs";

const run = (thunk) =>
  Effect.sync(() => {
    thunk();
  });

const generateDocs = Command.make("docs", {}, () => run(() => runGroup("generate-docs")));
const generateEffectManifests = Command.make("effect-manifests", {}, () =>
  run(() => runGroup("generate-effect-manifests")),
);
const generateSite = Command.make("site", {}, () => run(() => runGroup("generate-site")));
const generateCommand = Command.make("generate", {}, () =>
  Console.log("choose one of: docs, effect-manifests, site"),
).pipe(Command.withSubcommands([generateDocs, generateEffectManifests, generateSite]));

const guardId = Args.text({ name: "rule-id" });
const checkAll = Command.make("all", {}, () => run(() => runGroup("all")));
const checkDocs = Command.make("docs", {}, () => run(() => runGroup("check-docs")));
const checkEffectManifests = Command.make("effect-manifests", {}, () =>
  run(() => runGroup("check-effect-manifests")),
);
const checkRelease = Command.make("release", {}, () => run(() => runGroup("release")));
const checkGuard = Command.make("guard", { guardId }, ({ guardId }) =>
  run(() => runGuard(guardId)),
);
const checkGuards = Command.make("guards", {}, () =>
  run(() => {
    for (const id of listGuards()) console.log(id);
  }),
);
const checkCommand = Command.make("check", {}, () =>
  Console.log("choose one of: all, docs, effect-manifests, release, guard, guards"),
).pipe(
  Command.withSubcommands([
    checkAll,
    checkDocs,
    checkEffectManifests,
    checkRelease,
    checkGuard,
    checkGuards,
  ]),
);

const command = Command.make("agentos", {}, () =>
  Console.log("choose one of: check, generate"),
).pipe(Command.withSubcommands([checkCommand, generateCommand]));

const cli = Command.run(command, {
  name: "agentOS repository CLI",
  version: "0.5.16",
});

cli(process.argv).pipe(Effect.provide(NodeContext.layer), NodeRuntime.runMain);
