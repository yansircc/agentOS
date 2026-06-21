import { spawnSync } from "node:child_process";

const completedCommands = new Set();

export const runCommand = (command, { cwd, memoize = true } = {}) => {
  if (/\s--fix(?:\s|$)/u.test(command)) {
    throw new Error(`${command}: check commands must not run fix mode`);
  }
  if (memoize && completedCommands.has(command)) {
    console.log(`$ ${command} (already checked)`);
    return;
  }
  console.log(`$ ${command}`);
  const result = spawnSync("sh", ["-c", command], {
    cwd,
    env: process.env,
    stdio: "inherit",
  });
  if (result.signal !== null) throw new Error(`${command} terminated by ${result.signal}`);
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status ?? 1}`);
  if (memoize) completedCommands.add(command);
};
