import { spawn } from "node:child_process";
import { repoRoot } from "./gate-selector.mjs";
import { deriveAffectedGates, printAffectedGates, runAffectedGates } from "./gate-selector.mjs";

const runStage = (label, command, args) =>
  new Promise((resolve) => {
    console.log(`$ ${[command, ...args].join(" ")}`);
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit",
    });
    child.on("error", (error) => {
      resolve({ label, ok: false, durationMs: Date.now() - startedAt, error });
    });
    child.on("exit", (code, signal) => {
      resolve({
        label,
        ok: code === 0 && signal === null,
        durationMs: Date.now() - startedAt,
        error:
          signal === null
            ? code === 0
              ? undefined
              : `${label} exited with ${code ?? 1}`
            : `${label} terminated by ${signal}`,
      });
    });
  });

export const runDefaultGate = async () => {
  const startedAt = Date.now();
  const stages = await Promise.all([
    runStage("structural", "pnpm", ["run", "check:structural"]),
    runStage("typecheck", "pnpm", ["run", "typecheck"]),
    runStage("test", "pnpm", ["run", "test"]),
  ]);
  for (const stage of stages) {
    console.log(`${stage.label} duration: ${stage.durationMs}ms`);
  }
  const failed = stages.filter((stage) => !stage.ok);
  if (failed.length > 0) {
    throw new Error(failed.map((stage) => stage.error ?? `${stage.label} failed`).join("\n"));
  }
  const durationMs = Date.now() - startedAt;
  console.log(`fast gate duration: ${durationMs}ms`);
  const result = deriveAffectedGates();
  printAffectedGates(result);
  runAffectedGates(result);
};
