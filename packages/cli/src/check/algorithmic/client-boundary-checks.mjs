export const createClientBoundaryChecks = ({
  fs,
  path,
  repoRoot,
  read,
  readJson,
  walk,
  failIfAny,
}) => {
  const clientBoundaryPackages = {
    clientCore: "@agent-os/client",
    clientReact: "@agent-os/client/react",
    clientSvelte: "@agent-os/client/svelte",
    runtime: "@agent-os/runtime",
    workspaceAgent: "@agent-os/workspace-agent",
    agUiReact: "@agent-os/ag-ui-react",
    agUiSvelte: "@agent-os/ag-ui-svelte",
  };

  const clientFrameworkSubpaths = [
    {
      specifier: clientBoundaryPackages.clientReact,
      pathPrefix: "packages/client/src/react/",
      framework: "react",
    },
    {
      specifier: clientBoundaryPackages.clientSvelte,
      pathPrefix: "packages/client/src/svelte/",
      framework: "svelte",
    },
  ];

  const clientSourceFilePattern = /\.(?:ts|tsx|mts|cts|jsx|js|mjs|cjs|svelte|css|scss|less)$/u;
  const clientTypeScriptOnlyPattern = /\.ts$/u;

  const readJsonFile = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

  const workspacePackageRecords = () => {
    const rootPackage = readJson("package.json");
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
        const baseDir = path.join(repoRoot, base);
        if (!fs.existsSync(baseDir)) continue;
        for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const packagePath = `${base}/${entry.name}`;
          const packageJsonPath = path.join(repoRoot, packagePath, "package.json");
          if (!fs.existsSync(packageJsonPath)) continue;
          records.push({ name: readJsonFile(packageJsonPath).name, path: packagePath });
        }
        continue;
      }

      const packageJsonPath = path.join(repoRoot, workspace, "package.json");
      if (!fs.existsSync(packageJsonPath)) continue;
      records.push({ name: readJsonFile(packageJsonPath).name, path: workspace });
    }

    return records.sort((left, right) => left.path.localeCompare(right.path));
  };

  const clientImportSpecifiers = (source) => {
    const specifiers = [];
    const patterns = [
      /\b(?:import|export)\s+(?:type\s+)?(?:[^"'()]*?\s+from\s+)?["']([^"']+)["']/gu,
      /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
    ];
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
    }
    return specifiers;
  };

  const clientImportMatches = (specifier, packageName) =>
    specifier === packageName || specifier.startsWith(`${packageName}/`);

  const clientSectionBody = (source, heading) => {
    const start = source.indexOf(`## ${heading}`);
    if (start === -1) return "";
    const rest = source.slice(start + heading.length + 3);
    const next = rest.search(/^## /mu);
    return next === -1 ? rest : rest.slice(0, next);
  };

  const clientPackageByName = (packages, name) => packages.find((record) => record.name === name);

  const clientPackageSourceFiles = (record) =>
    walk(`${record.path}/src`).filter((file) => clientSourceFilePattern.test(path.basename(file)));

  const checkClientTypeScriptOnlySource = ({ record, failures }) => {
    for (const file of clientPackageSourceFiles(record)) {
      if (!clientTypeScriptOnlyPattern.test(path.basename(file))) {
        failures.push(
          `${file}: client-boundary-source: client/framework packages may contain .ts source only`,
        );
      }
    }
  };

  const checkClientFrameworkImports = ({ record, kind, failures }) => {
    const recordAllowedFramework =
      record.name === clientBoundaryPackages.agUiReact
        ? "react"
        : record.name === clientBoundaryPackages.agUiSvelte
          ? "svelte"
          : null;
    const frameworkPackages = ["react", "svelte", "svelte/store"];

    for (const file of clientPackageSourceFiles(record)) {
      const subpathAllowedFramework =
        clientFrameworkSubpaths.find((subpath) => file.startsWith(subpath.pathPrefix))?.framework ??
        null;
      const allowedFramework = subpathAllowedFramework ?? recordAllowedFramework;
      const source = read(file);
      for (const specifier of clientImportSpecifiers(source)) {
        const frameworkImport = frameworkPackages.find((framework) =>
          clientImportMatches(specifier, framework),
        );
        if (frameworkImport === undefined) continue;
        if (allowedFramework === null) {
          failures.push(
            `${file}: client-boundary-framework-import: ${kind} package must not import ${frameworkImport}`,
          );
        } else if (!clientImportMatches(frameworkImport, allowedFramework)) {
          failures.push(
            `${file}: client-boundary-framework-import: ${record.name} must not import ${frameworkImport}`,
          );
        }
      }
    }
  };

  const checkClientFrameworkBridgeReadModels = ({ record, failures }) => {
    for (const file of clientPackageSourceFiles(record)) {
      if (
        record.name !== clientBoundaryPackages.agUiReact &&
        record.name !== clientBoundaryPackages.agUiSvelte &&
        !clientFrameworkSubpaths.some((subpath) => file.startsWith(subpath.pathPrefix))
      ) {
        continue;
      }
      const source = read(file);
      const objectExportPatterns = [
        /\bexport\s+interface\s+([A-Za-z_$][\w$]*)[^{]*\{/gu,
        /\bexport\s+type\s+([A-Za-z_$][\w$]*)[^=]*=\s*\{/gu,
      ];
      for (const pattern of objectExportPatterns) {
        for (const match of source.matchAll(pattern)) {
          failures.push(
            `${file}: client-boundary-read-model: framework bridges must not declare exported object read-model type ${match[1]}; define canonical DTOs in runtime-protocol, runtime AG-UI projection types, or client core`,
          );
        }
      }
    }
  };

  const checkClientRetiredImports = ({ records, failures }) => {
    const retiredNames = [clientBoundaryPackages.agUiReact, clientBoundaryPackages.agUiSvelte];
    for (const record of records) {
      for (const file of clientPackageSourceFiles(record)) {
        const source = read(file);
        for (const specifier of clientImportSpecifiers(source)) {
          for (const retiredName of retiredNames) {
            if (record.name !== retiredName && clientImportMatches(specifier, retiredName)) {
              failures.push(
                `${file}: client-boundary-retired-import: ${record.name} imports retired framework package ${retiredName}`,
              );
            }
          }
        }
      }
    }
  };

  const checkClientRetiredPackageWindow = ({ surfacePackages, records, failures }) => {
    const retiredFrameworkPackages = [
      { retired: clientBoundaryPackages.agUiReact, successor: clientBoundaryPackages.clientReact },
      {
        retired: clientBoundaryPackages.agUiSvelte,
        successor: clientBoundaryPackages.clientSvelte,
      },
    ];

    for (const item of retiredFrameworkPackages) {
      const retiredRecord = clientPackageByName(records, item.retired);
      const retiredSurface = clientPackageByName(surfacePackages, item.retired);
      const successorRecord = clientPackageByName(records, clientBoundaryPackages.clientCore);
      const successorSurface = clientPackageByName(
        surfacePackages,
        clientBoundaryPackages.clientCore,
      );

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
      if (retiredSurface.apiSource !== undefined) {
        const apiSourcePath = path.join(repoRoot, retiredSurface.apiSource);
        if (fs.existsSync(apiSourcePath)) {
          const apiSource = fs.readFileSync(apiSourcePath, "utf8");
          if (clientSectionBody(apiSource, "Public exports").trim() !== "None.") {
            failures.push(
              `${retiredSurface.apiSource}: client-boundary-retired-surface: retired package must expose no active public exports`,
            );
          }
          if (!clientSectionBody(apiSource, "Deprecated exports").includes("`.:")) {
            failures.push(
              `${retiredSurface.apiSource}: client-boundary-retired-surface: retired exports must be declared as deprecated until deletion`,
            );
          }
        }
      }
    }
  };

  const checkClientCanonicalSurface = ({ surfacePackages, failures }) => {
    const runtime = clientPackageByName(surfacePackages, clientBoundaryPackages.runtime);
    if (runtime === undefined) {
      failures.push(
        "docs/surface.json: client-boundary-canonical-surface: @agent-os/runtime missing",
      );
      return;
    }
    if (!String(runtime.boundary ?? "").includes("./ag-ui")) {
      failures.push(
        "docs/surface.json: client-boundary-canonical-surface: @agent-os/runtime must declare ./ag-ui as the AG-UI wire projection subpath",
      );
    }
    if (!String(runtime.boundary ?? "").includes("runtime-protocol Recorded vocabulary")) {
      failures.push(
        "docs/surface.json: client-boundary-canonical-surface: @agent-os/runtime ./ag-ui boundary must state client state remains runtime-protocol Recorded vocabulary",
      );
    }
  };

  const checkClientBoundaryDoc = (failures) => {
    const boundaryPath = "packages/cli/src/check/sources/client-workspace-host-boundary.md";
    if (!fs.existsSync(path.join(repoRoot, boundaryPath))) {
      failures.push(
        `${boundaryPath}: client-boundary-contract: missing source-owned boundary freeze`,
      );
      return;
    }
    const source = read(boundaryPath);
    for (const marker of [
      "client state is a projection sink plus a command surface",
      "`@agent-os/runtime/ag-ui` is a framework-neutral opt-in wire projection",
      "`@agent-os/client/react` and `@agent-os/client/svelte` are the only framework",
      "Projection reads are replayable/read-model surfaces",
      "one driver mount",
      "projection sink configuration[]",
    ]) {
      if (!source.includes(marker)) {
        failures.push(`${boundaryPath}: client-boundary-contract: missing marker ${marker}`);
      }
    }
  };

  const checkClientBoundaries = () => {
    const failures = [];
    const surface = readJson("docs/surface.json");
    const surfacePackages = Array.isArray(surface.packages) ? surface.packages : [];
    const records = workspacePackageRecords();

    checkClientBoundaryDoc(failures);
    checkClientCanonicalSurface({ surfacePackages, failures });
    checkClientRetiredPackageWindow({ surfacePackages, records, failures });
    checkClientRetiredImports({ records, failures });

    const guardedNames = new Set([
      clientBoundaryPackages.clientCore,
      clientBoundaryPackages.agUiReact,
      clientBoundaryPackages.agUiSvelte,
    ]);
    for (const record of records) {
      if (!guardedNames.has(record.name)) continue;
      checkClientTypeScriptOnlySource({ record, failures });
      const kind =
        record.name === clientBoundaryPackages.clientCore ? "client core" : "framework bridge";
      checkClientFrameworkImports({ record, kind, failures });
      if (
        record.name === clientBoundaryPackages.clientCore ||
        record.name === clientBoundaryPackages.agUiReact ||
        record.name === clientBoundaryPackages.agUiSvelte
      ) {
        checkClientFrameworkBridgeReadModels({ record, failures });
      }
    }

    failIfAny("client boundaries", failures);
  };

  return {
    workspacePackageRecords,
    clientSectionBody,
    clientPackageByName,
    checkClientBoundaries,
  };
};
