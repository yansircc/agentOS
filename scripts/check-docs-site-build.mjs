#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const contentRoot = path.join(root, "tooling/docs-site/src/content/docs");
const distRoot = path.join(root, "tooling/docs-site/dist");
const failures = [];

const walk = (dir) => {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
      continue;
    }
    if (entry.isFile()) out.push(full);
  }
  return out;
};

const slash = (value) => value.replaceAll(path.sep, "/");
const rel = (file) => slash(path.relative(root, file));

const routeForContent = (file) => {
  const contentRel = slash(path.relative(contentRoot, file));
  if (contentRel === "index.md") return "index.html";
  return contentRel.replace(/\.md$/u, "/index.html");
};

const contentPages = walk(contentRoot)
  .filter((file) => file.endsWith(".md"))
  .sort();

if (contentPages.length === 0) {
  failures.push("docs-site projected content is empty");
}

for (const file of contentPages) {
  const built = path.join(distRoot, routeForContent(file));
  if (!fs.existsSync(built)) {
    failures.push(`${rel(file)} did not build ${rel(built)}`);
  }
}

const builtPages = walk(distRoot).filter((file) => file.endsWith(".html"));
if (builtPages.length <= 1) {
  failures.push(
    `docs-site build emitted ${builtPages.length} HTML page(s); expected projected docs routes`,
  );
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`checked docs-site build: ${contentPages.length} projected routes`);
