import { execFileSync } from "node:child_process";

const allowed = new Set(["spikes/_active/.gitkeep"]);

const trackedSpikes = execFileSync("git", ["ls-files", "spikes"], {
  encoding: "utf8",
})
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.length > 0);

const illegal = trackedSpikes.filter((path) => !allowed.has(path));

if (illegal.length > 0) {
  console.error("tracked spike files are not allowed outside spikes/_active/.gitkeep:");
  for (const path of illegal) {
    console.error(`- ${path}`);
  }
  process.exit(1);
}

console.log("spike hygiene check passed");
