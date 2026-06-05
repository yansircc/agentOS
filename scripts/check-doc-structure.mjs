#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const docsRoot = path.join(root, "docs");
const decisionsRoot = path.join(root, "decisions");
const failures = [];

const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const exists = (file) => fs.existsSync(path.join(root, file));
const readJson = (file) => JSON.parse(read(file));

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

const rel = (file) => path.relative(root, file).replaceAll(path.sep, "/");

const ensurePathExists = (file, owner) => {
  if (!exists(file)) failures.push(`${owner} references missing ${file}`);
};

const ensureUnique = (values, label) => {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) failures.push(`duplicate ${label}: ${value}`);
    seen.add(value);
  }
};

const markdownDocs = walk(docsRoot)
  .filter((file) => file.endsWith(".md"))
  .map(rel)
  .sort((left, right) => left.localeCompare(right));

const decisionDocs = walk(decisionsRoot)
  .filter((file) => file.endsWith(".md"))
  .map(rel)
  .sort((left, right) => left.localeCompare(right));

const englishDocs = markdownDocs.filter(
  (file) => !file.startsWith("docs/templates/") && !file.startsWith("docs/api/"),
);

if (exists("docs/decisions")) {
  failures.push("docs/decisions must not exist; decision records live in root decisions/");
}

for (const file of markdownDocs) {
  if (file.startsWith("docs/zh-cn/")) {
    failures.push(`${file} must not exist in a52; multilingual docs are deferred`);
  }
}

if (!exists("docs/README.md")) {
  failures.push("docs/README.md missing");
} else {
  const lines = read("docs/README.md").trimEnd().split(/\r?\n/u).length;
  if (lines > 30)
    failures.push(`docs/README.md has ${lines} lines; reader-intent router max is 30`);
}

if (!exists("docs/tutorials/sidebar.json")) {
  failures.push("docs/tutorials/sidebar.json missing");
} else {
  let sidebar;
  try {
    sidebar = JSON.parse(read("docs/tutorials/sidebar.json"));
  } catch (cause) {
    failures.push(`docs/tutorials/sidebar.json is not valid JSON: ${String(cause)}`);
  }
  const entries = Array.isArray(sidebar?.tutorials) ? sidebar.tutorials : [];
  if (!Array.isArray(sidebar?.tutorials)) {
    failures.push("docs/tutorials/sidebar.json must contain a tutorials array");
  }
  const seenSlugs = new Set();
  const listedFiles = [];
  entries.forEach((entry, index) => {
    const label = typeof entry?.label === "string" ? entry.label : "";
    const slug = typeof entry?.slug === "string" ? entry.slug : "";
    const expectedPrefix = `A${index + 1} `;
    if (!label.startsWith(expectedPrefix)) {
      failures.push(
        `docs/tutorials/sidebar.json entry ${index + 1} label must start ${expectedPrefix}`,
      );
    }
    if (!slug.startsWith("tutorials/")) {
      failures.push(`docs/tutorials/sidebar.json entry ${index + 1} slug must start tutorials/`);
      return;
    }
    if (seenSlugs.has(slug)) {
      failures.push(`docs/tutorials/sidebar.json repeats slug ${slug}`);
    }
    seenSlugs.add(slug);
    const file = `docs/${slug}.md`;
    listedFiles.push(file);
    if (!exists(file)) {
      failures.push(`docs/tutorials/sidebar.json references missing ${file}`);
    }
  });
  const tutorialFiles = markdownDocs
    .filter((file) => file.startsWith("docs/tutorials/"))
    .filter((file) => file !== "docs/tutorials/sidebar.json");
  const listed = new Set(listedFiles);
  for (const file of tutorialFiles) {
    if (!listed.has(file)) failures.push(`${file} missing from docs/tutorials/sidebar.json`);
  }
  for (const file of listedFiles) {
    if (!tutorialFiles.includes(file))
      failures.push(`${file} listed in sidebar but not a tutorial doc`);
  }
}

const headingExists = (text, heading) =>
  new RegExp(`^## ${heading.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "mu").test(text);

const requiredHeadings = [
  {
    dir: "docs/tutorials/",
    headings: ["Goal", "What You Build", "Prerequisites", "Steps", "Checkpoint", "Next"],
  },
  {
    dir: "docs/guides/",
    headings: ["Outcome", "Prerequisites", "Steps", "References"],
  },
  {
    dir: "docs/concepts/",
    headings: ["Problem", "Model", "Non-Goals", "Related"],
  },
];

for (const spec of requiredHeadings) {
  for (const file of markdownDocs.filter((candidate) => candidate.startsWith(spec.dir))) {
    const text = read(file);
    for (const heading of spec.headings) {
      if (!headingExists(text, heading)) failures.push(`${file} missing heading ## ${heading}`);
    }
  }
}

for (const file of decisionDocs) {
  const text = read(file);
  for (const heading of ["Situation", "Options", "Decision", "Kill Criterion", "Revisit"]) {
    if (!headingExists(text, heading)) failures.push(`${file} missing heading ## ${heading}`);
  }
}

const forbiddenHeadings = [
  { dir: "docs/packages/", heading: "Kill Criterion" },
  { dir: "docs/packages/", heading: "Situation" },
  { dir: "docs/packages/", heading: "Carrier Reference" },
  { dir: "docs/packages/", heading: "Event Kinds" },
  { dir: "docs/packages/", heading: "Settlement Vocabulary" },
  { dir: "docs/packages/", heading: "Authority Requirements" },
  { dir: "docs/packages/", heading: "Material Requirements" },
  { dir: "docs/concepts/", heading: "Steps" },
  { dir: "docs/guides/", heading: "Model" },
];

for (const spec of forbiddenHeadings) {
  for (const file of markdownDocs.filter((candidate) => candidate.startsWith(spec.dir))) {
    if (headingExists(read(file), spec.heading)) {
      failures.push(`${file} must not contain ## ${spec.heading}`);
    }
  }
}

const markdownLinkPattern = /\[[^\]\n]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu;
for (const file of markdownDocs.filter((candidate) => !candidate.startsWith("docs/templates/"))) {
  const text = read(file);
  for (const match of text.matchAll(markdownLinkPattern)) {
    const href = match[1];
    if (href.startsWith("https://github.com/yansircc/agentOS") && href.includes("/docs/")) {
      failures.push(`${file} uses GitHub absolute docs link ${href}; use relative .md links`);
    }
    if (href.startsWith("/") && !href.startsWith("//")) {
      failures.push(`${file} uses site-route docs link ${href}; use relative .md links`);
    }
  }
}

if (exists("tooling/docs-site/package.json")) {
  const surface = JSON.parse(read("docs/surface.json"));
  const docsSite = surface.packages.find((pkg) => pkg.path === "tooling/docs-site");
  if (docsSite === undefined) {
    failures.push("tooling/docs-site missing from docs/surface.json");
  } else if (docsSite.published !== false) {
    failures.push("tooling/docs-site must be declared with published: false");
  }
}

if (!exists("docs/reference/carriers.md")) {
  failures.push("docs/reference/carriers.md missing");
} else if (
  !read("docs/reference/carriers.md").includes(
    "generated by scripts/generate-carrier-reference.mjs",
  )
) {
  failures.push("docs/reference/carriers.md missing generated carrier reference notice");
}

const agentGeneratedMarkdownFiles = [
  "docs/start-here.md",
  "docs/agent/primitives.md",
  "docs/agent/errors.md",
  "docs/agent/invariant-matrix.md",
];

for (const file of agentGeneratedMarkdownFiles) {
  if (!exists(file)) {
    failures.push(`${file} missing`);
    continue;
  }
  const text = read(file);
  if (!text.includes("generated by scripts/generate-agent-docs.mjs")) {
    failures.push(`${file} missing generated agent docs notice`);
  }
  if (!text.includes("edit ")) {
    failures.push(`${file} missing generated source edit reference`);
  }
}

const agentGeneratedJsonFiles = [
  "docs/agent/recipes.json",
  "docs/agent/primitives.json",
  "docs/agent/errors.json",
  "docs/agent/invariant-matrix.json",
];

for (const file of agentGeneratedJsonFiles) {
  if (!exists(file)) {
    failures.push(`${file} missing`);
    continue;
  }
  const json = readJson(file);
  if (json.generatedBy !== "scripts/generate-agent-docs.mjs") {
    failures.push(`${file} missing generatedBy scripts/generate-agent-docs.mjs`);
  }
  const source = Array.isArray(json.source) ? json.source : [json.source].filter(Boolean);
  if (source.length === 0) {
    failures.push(`${file} missing source reference`);
  }
}

const agentSourceFiles = [
  "docs/agent/recipes.source.json",
  "docs/agent/invariants.source.json",
  "docs/agent/error-metadata.source.json",
  "docs/agent/external-vocabulary.source.json",
];

for (const file of agentSourceFiles) {
  if (!exists(file)) failures.push(`${file} missing`);
}

if (agentSourceFiles.every(exists)) {
  const recipesSource = readJson("docs/agent/recipes.source.json");
  const invariantsSource = readJson("docs/agent/invariants.source.json");
  const errorsSource = readJson("docs/agent/error-metadata.source.json");
  const externalVocabularySource = readJson("docs/agent/external-vocabulary.source.json");

  ensureUnique(
    recipesSource.recipes.map((recipe) => recipe.id),
    "agent recipe id",
  );
  ensureUnique(
    invariantsSource.invariants.map((invariant) => invariant.id),
    "agent invariant id",
  );
  ensureUnique(
    errorsSource.errors.map((error) => error.tag),
    "agent error metadata tag",
  );
  ensureUnique(
    externalVocabularySource.vocabulary.map((entry) => entry.id),
    "agent external vocabulary id",
  );

  const invariantIds = new Set(invariantsSource.invariants.map((invariant) => invariant.id));

  for (const recipe of recipesSource.recipes) {
    ensurePathExists(recipe.tutorial, recipe.id);
    for (const evidence of recipe.evidence) ensurePathExists(evidence, recipe.id);
    for (const command of recipe.commands) {
      const cwdMatch = command.match(/(?:^|\s)--cwd\s+("[^"]+"|'[^']+'|[^\s]+)/u);
      if (cwdMatch === null) continue;
      const cwd = cwdMatch[1].replace(/^["']|["']$/gu, "");
      ensurePathExists(cwd, `${recipe.id} command ${command}`);
    }
  }

  for (const invariant of invariantsSource.invariants) {
    ensurePathExists(invariant.docs, invariant.id);
    for (const decision of invariant.decisions) ensurePathExists(decision, invariant.id);
    for (const test of invariant.tests) ensurePathExists(test, invariant.id);
  }

  for (const error of errorsSource.errors) {
    ensurePathExists(error.docs, error.tag);
    for (const invariant of error.invariants) {
      if (!invariantIds.has(invariant)) {
        failures.push(`${error.tag} references unknown invariant ${invariant}`);
      }
    }
  }

  for (const entry of externalVocabularySource.vocabulary) {
    ensurePathExists(entry.docs, entry.id);
  }
}

if (exists("docs/agent/primitives.json")) {
  const primitivesJson = readJson("docs/agent/primitives.json");
  const primitives = Array.isArray(primitivesJson.primitives) ? primitivesJson.primitives : [];
  ensureUnique(
    primitives.map((primitive) => primitive.id),
    "agent primitive id",
  );
  for (const primitive of primitives) {
    ensurePathExists(primitive.packagePath, primitive.id);
    ensurePathExists(primitive.sourceFile, primitive.id);
    ensurePathExists(primitive.docs, primitive.id);
  }
}

const forbiddenD10AgentDocPatterns = [
  /\bLedgerEvent\.scope\b/u,
  /\breadonly\s+scope\s*:\s*string\b/u,
  /\bscope\s*:\s*string\b/u,
];

for (const file of walk(path.join(root, "docs/agent")).map(rel)) {
  if (!/\.(?:md|json)$/u.test(file)) continue;
  const text = read(file);
  for (const pattern of forbiddenD10AgentDocPatterns) {
    if (pattern.test(text)) failures.push(`${file} contains pre-D10 scope:string ledger language`);
  }
}

if (!exists("AGENTS.md")) {
  failures.push("AGENTS.md missing");
} else {
  const agentsText = read("AGENTS.md");
  if (
    !agentsText.includes("<!-- agent-docs-navigation:start -->") ||
    !agentsText.includes("<!-- agent-docs-navigation:end -->")
  ) {
    failures.push("AGENTS.md missing generated agent navigation markers");
  }
  if (!agentsText.includes("generated by scripts/generate-agent-docs.mjs")) {
    failures.push("AGENTS.md missing generated agent navigation notice");
  }
}

for (const file of walk(path.join(root, "tooling/docs-site/src/content/docs"))
  .filter((candidate) => candidate.endsWith(".md"))
  .map(rel)) {
  if (file.startsWith("tooling/docs-site/src/content/docs/decisions/")) {
    failures.push(`${file} must not be projected into the public docs site`);
  }
  const text = read(file);
  if (!text.includes("generated by scripts/project-docs-site.mjs")) {
    failures.push(`${file} missing generated projection notice`);
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`checked docs structure: ${englishDocs.length} English docs`);
