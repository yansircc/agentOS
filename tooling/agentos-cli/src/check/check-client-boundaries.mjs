#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = process.cwd();

const CLIENT_CORE = "@agent-os/client";
const CLIENT_REACT = "@agent-os/client-react";
const CLIENT_SVELTE = "@agent-os/client-svelte";
const WORKSPACE_AGENT = "@agent-os/workspace-agent";
const AG_UI_REACT = "@agent-os/ag-ui-react";
const AG_UI_SVELTE = "@agent-os/ag-ui-svelte";

const sourceFilePattern = /\.(?:ts|tsx|mts|cts|jsx|js|mjs|cjs|svelte|css|scss|less)$/u;
const typeScriptOnlyPattern = /\.ts$/u;
const ignoredDirs = new Set(["node_modules", "dist", ".wrangler", ".turbo", ".git"]);

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const exists = (file) => fs.existsSync(file);
const repoPath = (root, file) => path.relative(root, file).split(path.sep).join("/");

const visitFiles = (dir) => {
  const files = [];
  const visit = (current) => {
    if (!exists(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirs.has(entry.name)) visit(next);
        continue;
      }
      files.push(next);
    }
  };
  visit(dir);
  return files.sort((left, right) => left.localeCompare(right));
};

const workspacePackageRecords = (root) => {
  const rootPackage = readJson(path.join(root, "package.json"));
  const workspaces = Array.isArray(rootPackage.workspaces)
    ? rootPackage.workspaces
    : Array.isArray(rootPackage.workspaces?.packages)
      ? rootPackage.workspaces.packages
      : [];
  const records = [];

  for (const workspace of workspaces) {
    if (typeof workspace !== "string") continue;
    if (workspace.endsWith("/*")) {
      const base = workspace.slice(0, -2);
      const baseDir = path.join(root, base);
      if (!exists(baseDir)) continue;
      for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const packagePath = `${base}/${entry.name}`;
        const packageJsonPath = path.join(root, packagePath, "package.json");
        if (!exists(packageJsonPath)) continue;
        const manifest = readJson(packageJsonPath);
        records.push({ name: manifest.name, path: packagePath, manifest });
      }
      continue;
    }

    const packageJsonPath = path.join(root, workspace, "package.json");
    if (!exists(packageJsonPath)) continue;
    const manifest = readJson(packageJsonPath);
    records.push({ name: manifest.name, path: workspace, manifest });
  }

  return records.sort((left, right) => left.path.localeCompare(right.path));
};

const importSpecifiers = (source) => {
  const specifiers = [];
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[^"'()]*?\s+from\s+)?["']([^"']+)["']/gu,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      specifiers.push(match[1]);
    }
  }
  return specifiers;
};

const importMatches = (specifier, packageName) =>
  specifier === packageName || specifier.startsWith(`${packageName}/`);

const sectionBody = (source, heading) => {
  const start = source.indexOf(`## ${heading}`);
  if (start === -1) return "";
  const rest = source.slice(start + heading.length + 3);
  const next = rest.search(/^## /mu);
  return next === -1 ? rest : rest.slice(0, next);
};

const packageByName = (packages, name) => packages.find((record) => record.name === name);

const surfacePackageByName = (surfacePackages, name) =>
  surfacePackages.find((record) => record.name === name);

const packageSourceFiles = (root, record) =>
  visitFiles(path.join(root, record.path, "src")).filter((file) =>
    sourceFilePattern.test(path.basename(file)),
  );

const checkTypeScriptOnlySource = ({ root, record, failures }) => {
  for (const file of packageSourceFiles(root, record)) {
    if (!typeScriptOnlyPattern.test(path.basename(file))) {
      failures.push(
        `${repoPath(root, file)}: client-boundary-source: client/framework packages may contain .ts source only`,
      );
    }
  }
};

const checkFrameworkImports = ({ root, record, kind, failures }) => {
  const allowedFramework =
    record.name === CLIENT_REACT || record.name === AG_UI_REACT
      ? "react"
      : record.name === CLIENT_SVELTE || record.name === AG_UI_SVELTE
        ? "svelte"
        : null;
  const frameworkPackages = ["react", "svelte", "svelte/store"];

  for (const file of packageSourceFiles(root, record)) {
    const source = fs.readFileSync(file, "utf8");
    for (const specifier of importSpecifiers(source)) {
      const frameworkImport = frameworkPackages.find((framework) =>
        importMatches(specifier, framework),
      );
      if (frameworkImport === undefined) continue;
      if (allowedFramework === null) {
        failures.push(
          `${repoPath(root, file)}: client-boundary-framework-import: ${kind} package must not import ${frameworkImport}`,
        );
        continue;
      }
      if (!importMatches(frameworkImport, allowedFramework)) {
        failures.push(
          `${repoPath(root, file)}: client-boundary-framework-import: ${record.name} must not import ${frameworkImport}`,
        );
      }
    }
  }
};

const checkFrameworkBridgeReadModels = ({ root, record, failures }) => {
  for (const file of packageSourceFiles(root, record)) {
    const source = fs.readFileSync(file, "utf8");
    const objectExportPatterns = [
      /\bexport\s+interface\s+([A-Za-z_$][\w$]*)[^{]*\{/gu,
      /\bexport\s+type\s+([A-Za-z_$][\w$]*)[^=]*=\s*\{/gu,
    ];
    for (const pattern of objectExportPatterns) {
      for (const match of source.matchAll(pattern)) {
        failures.push(
          `${repoPath(root, file)}: client-boundary-read-model: framework bridges must not declare exported object read-model type ${match[1]}; define canonical DTOs in runtime-protocol, workspace-agent, ag-ui, or client core`,
        );
      }
    }
  }
};

const checkRetiredImports = ({ root, records, failures }) => {
  const retiredNames = [AG_UI_REACT, AG_UI_SVELTE];
  for (const record of records) {
    for (const file of packageSourceFiles(root, record)) {
      const source = fs.readFileSync(file, "utf8");
      for (const specifier of importSpecifiers(source)) {
        for (const retiredName of retiredNames) {
          if (record.name === retiredName) continue;
          if (importMatches(specifier, retiredName)) {
            failures.push(
              `${repoPath(root, file)}: client-boundary-retired-import: ${record.name} imports retired framework package ${retiredName}`,
            );
          }
        }
      }
    }
  }
};

const checkRetiredPackageWindow = ({ root, surfacePackages, records, failures }) => {
  const retiredFrameworkPackages = [
    { retired: AG_UI_REACT, successor: CLIENT_REACT },
    { retired: AG_UI_SVELTE, successor: CLIENT_SVELTE },
  ];

  for (const item of retiredFrameworkPackages) {
    const retiredRecord = packageByName(records, item.retired);
    const retiredSurface = surfacePackageByName(surfacePackages, item.retired);
    const successorRecord = packageByName(records, item.successor);
    const successorSurface = surfacePackageByName(surfacePackages, item.successor);

    if (
      (successorRecord !== undefined || successorSurface !== undefined) &&
      retiredRecord !== undefined
    ) {
      failures.push(
        `${retiredRecord.path}: client-boundary-retired-surface: ${item.retired} must be deleted once ${item.successor} exists`,
      );
    }
    if (
      (successorRecord !== undefined || successorSurface !== undefined) &&
      retiredSurface !== undefined
    ) {
      failures.push(
        `docs/surface.json: client-boundary-retired-surface: ${item.retired} must leave the public surface once ${item.successor} exists`,
      );
    }
    if (retiredRecord === undefined && retiredSurface === undefined) continue;
    if (retiredSurface === undefined) {
      failures.push(
        `${item.retired}: client-boundary-retired-surface: retired workspace package must remain source-owned in docs/surface.json until deletion`,
      );
      continue;
    }
    if (!String(retiredSurface.status ?? "").startsWith("retired")) {
      failures.push(
        `docs/surface.json: client-boundary-retired-surface: ${item.retired} must have retired status before deletion`,
      );
    }
    if (!String(retiredSurface.apiStatus ?? "").includes("scheduled for deletion")) {
      failures.push(
        `docs/surface.json: client-boundary-retired-surface: ${item.retired} apiStatus must declare deletion, not compatibility preservation`,
      );
    }
    if (
      retiredSurface.apiSource !== undefined &&
      exists(path.join(root, retiredSurface.apiSource))
    ) {
      const apiSource = fs.readFileSync(path.join(root, retiredSurface.apiSource), "utf8");
      const publicExports = sectionBody(apiSource, "Public exports").trim();
      const deprecatedExports = sectionBody(apiSource, "Deprecated exports").trim();
      if (publicExports !== "None.") {
        failures.push(
          `${retiredSurface.apiSource}: client-boundary-retired-surface: retired package must expose no active public exports`,
        );
      }
      if (!deprecatedExports.includes("`.:")) {
        failures.push(
          `${retiredSurface.apiSource}: client-boundary-retired-surface: retired exports must be declared as deprecated until deletion`,
        );
      }
    }
  }
};

const checkCanonicalSurface = ({ surfacePackages, failures }) => {
  const agUi = surfacePackageByName(surfacePackages, "@agent-os/ag-ui");
  if (agUi === undefined) {
    failures.push("docs/surface.json: client-boundary-canonical-surface: @agent-os/ag-ui missing");
    return;
  }
  if (!String(agUi.boundary ?? "").includes("opt-in AG-UI edge protocol projection")) {
    failures.push(
      "docs/surface.json: client-boundary-canonical-surface: @agent-os/ag-ui must be declared as opt-in wire projection",
    );
  }
  if (!String(agUi.boundary ?? "").includes("runtime-protocol Recorded vocabulary")) {
    failures.push(
      "docs/surface.json: client-boundary-canonical-surface: @agent-os/ag-ui boundary must state client state remains runtime-protocol Recorded vocabulary",
    );
  }
};

const checkBoundaryDoc = ({ root, failures }) => {
  const boundaryPath = path.join(root, "tooling/refactor/a78-a94/client-app-kit-boundary.md");
  if (!exists(boundaryPath)) {
    failures.push(
      "tooling/refactor/a78-a94/client-app-kit-boundary.md: client-boundary-contract: missing source-owned boundary freeze",
    );
    return;
  }
  const source = fs.readFileSync(boundaryPath, "utf8");
  for (const marker of [
    "client state is a projection sink plus a command surface",
    "`@agent-os/ag-ui` is a framework-neutral opt-in wire projection",
    "`@agent-os/client-react` and `@agent-os/client-svelte` are the only framework",
    "Projection reads are replayable/read-model surfaces",
    "one driver mount",
    "projection sink configuration[]",
  ]) {
    if (!source.includes(marker)) {
      failures.push(
        `tooling/refactor/a78-a94/client-app-kit-boundary.md: client-boundary-contract: missing marker ${JSON.stringify(marker)}`,
      );
    }
  }
};

const collectFailures = (root) => {
  const failures = [];
  const surfacePath = path.join(root, "docs/surface.json");
  if (!exists(surfacePath)) {
    return ["docs/surface.json: client-boundary-surface: missing surface source"];
  }
  const surface = readJson(surfacePath);
  const surfacePackages = Array.isArray(surface.packages) ? surface.packages : [];
  const records = workspacePackageRecords(root);

  checkBoundaryDoc({ root, failures });
  checkCanonicalSurface({ surfacePackages, failures });
  checkRetiredPackageWindow({ root, surfacePackages, records, failures });
  checkRetiredImports({ root, records, failures });

  const guardedNames = new Set([
    CLIENT_CORE,
    CLIENT_REACT,
    CLIENT_SVELTE,
    WORKSPACE_AGENT,
    AG_UI_REACT,
    AG_UI_SVELTE,
  ]);
  for (const record of records) {
    if (!guardedNames.has(record.name)) continue;
    checkTypeScriptOnlySource({ root, record, failures });
    const kind =
      record.name === CLIENT_CORE
        ? "client core"
        : record.name === WORKSPACE_AGENT
          ? "workspace app-kit"
          : "framework bridge";
    checkFrameworkImports({ root, record, kind, failures });
    if (
      record.name === CLIENT_REACT ||
      record.name === CLIENT_SVELTE ||
      record.name === AG_UI_REACT ||
      record.name === AG_UI_SVELTE
    ) {
      checkFrameworkBridgeReadModels({ root, record, failures });
    }
  }

  return failures;
};

const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

const writeText = (file, source) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
};

const fixtureRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-client-boundaries-"));
  writeJson(path.join(root, "package.json"), {
    private: true,
    workspaces: ["packages/*"],
    type: "module",
  });
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  writeText(
    path.join(root, "tooling/refactor/a78-a94/client-app-kit-boundary.md"),
    [
      "client state is a projection sink plus a command surface",
      "`@agent-os/ag-ui` is a framework-neutral opt-in wire projection",
      "`@agent-os/client-react` and `@agent-os/client-svelte` are the only framework",
      "Projection reads are replayable/read-model surfaces",
      "one driver mount",
      "projection sink configuration[]",
      "",
    ].join("\n"),
  );
  return root;
};

const addPackage = (root, { name, source, apiSource }) => {
  const slug = name.split("/").at(-1);
  const packagePath = `packages/${slug}`;
  writeJson(path.join(root, packagePath, "package.json"), {
    name,
    private: true,
    type: "module",
    exports: { ".": "./src/index.ts" },
  });
  writeText(path.join(root, packagePath, "src/index.ts"), source);
  if (apiSource !== undefined) writeText(path.join(root, apiSource.path), apiSource.source);
  return packagePath;
};

const writeSurface = (root, packages) => {
  writeJson(path.join(root, "docs/surface.json"), {
    packages: [
      {
        slug: "ag-ui",
        name: "@agent-os/ag-ui",
        path: "packages/ag-ui",
        status: "public",
        boundary:
          "framework-neutral opt-in AG-UI edge protocol projection; client state remains the runtime-protocol Recorded vocabulary",
        published: true,
      },
      ...packages,
    ],
  });
  addPackage(root, {
    name: "@agent-os/ag-ui",
    source: "export type AgUiFrame = { readonly type: string };\n",
  });
};

const expectFailure = (label, build, expected) => {
  const root = fixtureRoot();
  try {
    build(root);
    const failures = collectFailures(root);
    if (!failures.some((failure) => failure.includes(expected))) {
      return `${label}: expected failure containing ${expected}, got ${JSON.stringify(failures)}`;
    }
    return null;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

const expectPass = (label, build) => {
  const root = fixtureRoot();
  try {
    build(root);
    const failures = collectFailures(root);
    if (failures.length > 0) return `${label}: expected pass, got ${JSON.stringify(failures)}`;
    return null;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

const collectSelfTestFailures = () => {
  const failures = [];

  const goodRetiredWindow = expectPass("retired packages may exist before successors", (root) => {
    addPackage(root, {
      name: AG_UI_REACT,
      source:
        'import { useSyncExternalStore } from "react";\nexport const useAgUi = () => useSyncExternalStore;\n',
      apiSource: {
        path: "docs/api/ag-ui-react.md",
        source:
          "# API\n\n## Public exports\n\nNone.\n\n## Experimental exports\n\nNone.\n\n## Deprecated exports\n\n- `.:useAgUi`\n\n## Internal-only exports\n\nNone.\n",
      },
    });
    writeSurface(root, [
      {
        slug: "ag-ui-react",
        name: AG_UI_REACT,
        path: "packages/ag-ui-react",
        status: "retired by client package migration",
        apiStatus: "scheduled for deletion",
        apiSource: "docs/api/ag-ui-react.md",
        published: true,
      },
    ]);
  });
  if (goodRetiredWindow !== null) failures.push(goodRetiredWindow);

  const badComponent = expectFailure(
    "component source rejected",
    (root) => {
      addPackage(root, {
        name: CLIENT_REACT,
        source:
          'import { useSyncExternalStore } from "react";\nexport const useClientStore = () => useSyncExternalStore;\n',
      });
      writeText(
        path.join(root, "packages/client-react/src/View.tsx"),
        "export const View = () => null;\n",
      );
      writeSurface(root, [
        {
          slug: "client-react",
          name: CLIENT_REACT,
          path: "packages/client-react",
          status: "public",
          published: true,
        },
      ]);
    },
    "client-boundary-source",
  );
  if (badComponent !== null) failures.push(badComponent);

  const badLocalReadModel = expectFailure(
    "local object read-model rejected",
    (root) => {
      addPackage(root, {
        name: CLIENT_SVELTE,
        source:
          'import { readable } from "svelte/store";\nexport interface TimelineItem { readonly id: string }\nexport const clientReadable = readable;\n',
      });
      writeSurface(root, [
        {
          slug: "client-svelte",
          name: CLIENT_SVELTE,
          path: "packages/client-svelte",
          status: "public",
          published: true,
        },
      ]);
    },
    "client-boundary-read-model",
  );
  if (badLocalReadModel !== null) failures.push(badLocalReadModel);

  const badCoreFrameworkImport = expectFailure(
    "client core framework import rejected",
    (root) => {
      addPackage(root, {
        name: CLIENT_CORE,
        source:
          'import { useSyncExternalStore } from "react";\nexport const createAgentClient = () => useSyncExternalStore;\n',
      });
      writeSurface(root, [
        {
          slug: "client",
          name: CLIENT_CORE,
          path: "packages/client",
          status: "public",
          published: true,
        },
      ]);
    },
    "client-boundary-framework-import",
  );
  if (badCoreFrameworkImport !== null) failures.push(badCoreFrameworkImport);

  const badRetiredCoexistence = expectFailure(
    "successor and retired package cannot coexist",
    (root) => {
      addPackage(root, {
        name: AG_UI_REACT,
        source:
          'import { useSyncExternalStore } from "react";\nexport const useAgUi = () => useSyncExternalStore;\n',
        apiSource: {
          path: "docs/api/ag-ui-react.md",
          source:
            "# API\n\n## Public exports\n\nNone.\n\n## Experimental exports\n\nNone.\n\n## Deprecated exports\n\n- `.:useAgUi`\n\n## Internal-only exports\n\nNone.\n",
        },
      });
      addPackage(root, {
        name: CLIENT_REACT,
        source:
          'import { useSyncExternalStore } from "react";\nexport const useClientStore = () => useSyncExternalStore;\n',
      });
      writeSurface(root, [
        {
          slug: "ag-ui-react",
          name: AG_UI_REACT,
          path: "packages/ag-ui-react",
          status: "retired by client package migration",
          apiStatus: "scheduled for deletion",
          apiSource: "docs/api/ag-ui-react.md",
          published: true,
        },
        {
          slug: "client-react",
          name: CLIENT_REACT,
          path: "packages/client-react",
          status: "public",
          published: true,
        },
      ]);
    },
    "client-boundary-retired-surface",
  );
  if (badRetiredCoexistence !== null) failures.push(badRetiredCoexistence);

  return failures;
};

const selfTest = process.argv.includes("--self-test");
const failures = selfTest ? collectSelfTestFailures() : collectFailures(repoRoot);

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(selfTest ? "client boundary guard self-test passed" : "client boundary guard passed");
