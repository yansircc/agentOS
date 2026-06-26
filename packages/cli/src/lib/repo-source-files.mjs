import fs from "node:fs";
import path from "node:path";

export const repoSourceIgnoredDirectoryNames = Object.freeze(
  new Set(["node_modules", "dist", ".wrangler", ".turbo", ".parallel", ".cst", ".git", ".codex"]),
);

const compare = (left, right) => left.localeCompare(right);

const toRepoPath = (file) => file.split(path.sep).join("/");

export const walkRepoSourceFiles = (repoRoot, relativePath = ".", options = {}) => {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(absolutePath)) return [];
  const stat = fs.statSync(absolutePath);
  if (stat.isFile()) return [toRepoPath(relativePath)];
  const ignored = options.ignored ?? repoSourceIgnoredDirectoryNames;
  const files = [];
  for (const entry of fs.readdirSync(absolutePath, { withFileTypes: true })) {
    if (entry.isDirectory() && ignored.has(entry.name)) continue;
    const child = path.join(relativePath, entry.name);
    if (entry.isDirectory()) files.push(...walkRepoSourceFiles(repoRoot, child, options));
    if (entry.isFile()) files.push(toRepoPath(child));
  }
  return files.sort(compare);
};
