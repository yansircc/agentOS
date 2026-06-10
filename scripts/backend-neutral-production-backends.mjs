import fs from "node:fs";
import path from "node:path";

export const productionBackendPackagesPath = "agentos.backendNeutrality.productionBackendPackages";

export const readJson = (root, rel) => JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));

export const normalizeBackendPackagePath = (value) =>
  value.replace(/^\.\//u, "").replace(/\/+$/u, "");

export const sameStringSet = (left, right) => {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return (
    leftSet.size === left.length &&
    rightSet.size === right.length &&
    leftSet.size === rightSet.size &&
    [...leftSet].every((value) => rightSet.has(value))
  );
};

export const collectProductionBackendPackageSet = (
  root,
  { minCount = 0, requireExistingSrc = true } = {},
) => {
  const failures = [];
  const rootPackage = readJson(root, "package.json");
  const raw = rootPackage.agentos?.backendNeutrality?.productionBackendPackages;

  if (!Array.isArray(raw)) {
    return {
      rootPackage,
      productionBackends: [],
      failures: [`package.json must declare ${productionBackendPackagesPath} as an array`],
    };
  }

  const productionBackends = [];
  raw.forEach((value, index) => {
    if (typeof value !== "string") {
      failures.push(`${productionBackendPackagesPath}[${index}] must be a string`);
      return;
    }
    const backendPath = normalizeBackendPackagePath(value);
    if (backendPath.length === 0) {
      failures.push(`${productionBackendPackagesPath}[${index}] must not be empty`);
      return;
    }
    productionBackends.push(backendPath);
  });

  const seen = new Set();
  for (const backendPath of productionBackends) {
    if (seen.has(backendPath)) {
      failures.push(`${productionBackendPackagesPath} must not contain duplicate ${backendPath}`);
    }
    seen.add(backendPath);
    if (!backendPath.startsWith("packages/backends/")) {
      failures.push(`production backend must live under packages/backends: ${backendPath}`);
    }
    if (/(?:^|\/)(?:in-memory|protocol|reference)(?:$|\/)/u.test(backendPath)) {
      failures.push(
        `non-production/reference backend cannot count toward backend-neutral status: ${backendPath}`,
      );
    }
    if (requireExistingSrc && !fs.existsSync(path.join(root, backendPath, "src"))) {
      failures.push(`production backend path must exist and contain src: ${backendPath}`);
    }
  }

  if (new Set(productionBackends).size < minCount) {
    failures.push(
      `backend-neutral requires at least ${minCount} production backends, excluding in-memory/reference; actual ${new Set(productionBackends).size}`,
    );
  }

  return { rootPackage, productionBackends, failures };
};
