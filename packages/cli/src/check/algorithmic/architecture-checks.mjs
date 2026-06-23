export const createArchitectureChecks = ({
  fs,
  path,
  graphWorkspacePackageRecords,
  sourceModuleGraph,
  importSpecifierRecords,
  repoRoot,
  read,
  readJson,
  walk,
  compare,
  isRecord,
  failIfAny,
  ownerIdRegistry,
  ownerIdRegistryFindings,
  packageExportSubpaths,
}) => {
  const moduleBucketRegistryPath = "architecture/module-buckets.json";
  let moduleBucketRegistryCache;
  const moduleBucketRegistry = () => {
    moduleBucketRegistryCache ??= readJson(moduleBucketRegistryPath);
    return moduleBucketRegistryCache;
  };

  const pathRuleMatches = (file, rule) => {
    if (!isRecord(rule) || typeof rule.match !== "string") return false;
    if (rule.match === "all") return true;
    if (typeof rule.value !== "string") return false;
    if (rule.match === "prefix") return file.startsWith(rule.value);
    if (rule.match === "contains") return file.includes(rule.value);
    if (rule.match === "suffix") return file.endsWith(rule.value);
    if (rule.match === "regex") return new RegExp(rule.value, "u").test(file);
    return false;
  };

  const specifierRuleMatches = (specifier, rule) => {
    if (!isRecord(rule) || typeof rule.match !== "string" || typeof rule.value !== "string") {
      return false;
    }
    if (rule.match === "specifier") return specifier === rule.value;
    if (rule.match === "prefix") return specifier.startsWith(rule.value);
    if (rule.match === "specifier-or-subpath") {
      return specifier === rule.value || specifier.startsWith(`${rule.value}/`);
    }
    return false;
  };

  const moduleRuleClassification = (file, rules, property) => {
    for (const rule of rules) {
      if (pathRuleMatches(file, rule)) return rule[property];
    }
    throw new Error(`${moduleBucketRegistryPath}: no ${property} rule matches ${file}`);
  };

  const moduleBucketForPath = (file) =>
    moduleRuleClassification(file, moduleBucketRegistry().bucketRules, "bucket");

  const moduleAmbientForPath = (file) =>
    moduleRuleClassification(file, moduleBucketRegistry().ambientRules, "ambient");

  const moduleBucketRank = () =>
    new Map(moduleBucketRegistry().buckets.map((bucket) => [bucket.id, bucket.rank]));

  const allowedAmbientImports = () =>
    new Map(
      moduleBucketRegistry().ambients.map((ambient) => [
        ambient.id,
        new Set(ambient.allowedImports),
      ]),
    );

  const ejectionBuckets = () =>
    new Set(
      moduleBucketRegistry()
        .buckets.filter((bucket) => bucket.ejection === true)
        .map((bucket) => bucket.id),
    );

  const externalAmbientForSpecifier = (specifier) => {
    for (const rule of moduleBucketRegistry().externalAmbients) {
      if (specifierRuleMatches(specifier, rule)) return rule.ambient;
    }
    return undefined;
  };

  const modulePathRuleMatchKinds = new Set(["all", "prefix", "contains", "suffix", "regex"]);
  const moduleSpecifierRuleMatchKinds = new Set(["specifier", "prefix", "specifier-or-subpath"]);
  const moduleBucketFindingKinds = new Set([
    "bucket-dag",
    "ambient-dag",
    "external-ambient",
    "product-ejection",
  ]);

  const stringArray = (value) =>
    Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0);

  const validateModulePathRules = ({ label, rules, property, allowedValues, findings }) => {
    if (!Array.isArray(rules) || rules.length === 0) {
      findings.push(`${moduleBucketRegistryPath}:${label}: must be a non-empty array`);
      return;
    }
    const seen = new Set();
    let hasCatchAll = false;
    for (const [index, rule] of rules.entries()) {
      const ruleLabel = `${moduleBucketRegistryPath}:${label}[${index}]`;
      if (!isRecord(rule)) {
        findings.push(`${ruleLabel}: rule must be an object`);
        continue;
      }
      if (typeof rule.id !== "string" || rule.id.length === 0) {
        findings.push(`${ruleLabel}: id must be a non-empty string`);
      } else if (seen.has(rule.id)) {
        findings.push(`${ruleLabel}: duplicate id ${rule.id}`);
      } else {
        seen.add(rule.id);
      }
      if (!modulePathRuleMatchKinds.has(rule.match)) {
        findings.push(
          `${ruleLabel}: match must be one of ${[...modulePathRuleMatchKinds].join(", ")}`,
        );
      }
      if (rule.match === "all") {
        hasCatchAll = true;
      } else if (typeof rule.value !== "string" || rule.value.length === 0) {
        findings.push(`${ruleLabel}: value must be a non-empty string`);
      }
      if (rule.match === "regex" && typeof rule.value === "string") {
        try {
          new RegExp(rule.value, "u");
        } catch (error) {
          findings.push(`${ruleLabel}: regex is invalid: ${error.message}`);
        }
      }
      if (typeof rule[property] !== "string" || !allowedValues.has(rule[property])) {
        findings.push(`${ruleLabel}: ${property} must reference a declared ${property}`);
      }
    }
    if (!hasCatchAll) {
      findings.push(`${moduleBucketRegistryPath}:${label}: final catch-all rule is required`);
    }
  };

  const moduleBucketRegistryFindings = (registry) => {
    const findings = [];
    if (!isRecord(registry)) return [`${moduleBucketRegistryPath}: registry must be a JSON object`];
    if (registry.schemaVersion !== 1) {
      findings.push(`${moduleBucketRegistryPath}: schemaVersion must be 1`);
    }
    if (!isRecord(registry.policy)) {
      findings.push(`${moduleBucketRegistryPath}: policy object is required`);
    } else {
      for (const key of ["classification", "ambientIsolation", "productBucket"]) {
        if (typeof registry.policy[key] !== "string" || registry.policy[key].length === 0) {
          findings.push(`${moduleBucketRegistryPath}: policy.${key} must be a non-empty string`);
        }
      }
    }
    if (!isRecord(registry.productEjection)) {
      findings.push(`${moduleBucketRegistryPath}: productEjection object is required`);
    } else {
      if (!stringArray(registry.productEjection.packagePathPrefixes)) {
        findings.push(
          `${moduleBucketRegistryPath}: productEjection.packagePathPrefixes must be a non-empty string array`,
        );
      }
      if (
        typeof registry.productEjection.reason !== "string" ||
        registry.productEjection.reason.length === 0
      ) {
        findings.push(
          `${moduleBucketRegistryPath}: productEjection.reason must be a non-empty string`,
        );
      }
    }

    const bucketIds = new Set();
    if (!Array.isArray(registry.buckets) || registry.buckets.length === 0) {
      findings.push(`${moduleBucketRegistryPath}: buckets must be a non-empty array`);
    } else {
      const ranks = new Set();
      for (const [index, bucket] of registry.buckets.entries()) {
        const label = `${moduleBucketRegistryPath}:buckets[${index}]`;
        if (!isRecord(bucket)) {
          findings.push(`${label}: bucket must be an object`);
          continue;
        }
        if (typeof bucket.id !== "string" || bucket.id.length === 0) {
          findings.push(`${label}: id must be a non-empty string`);
        } else if (bucketIds.has(bucket.id)) {
          findings.push(`${label}: duplicate id ${bucket.id}`);
        } else {
          bucketIds.add(bucket.id);
        }
        if (!Number.isInteger(bucket.rank) || bucket.rank < 0) {
          findings.push(`${label}: rank must be a non-negative integer`);
        } else if (ranks.has(bucket.rank)) {
          findings.push(`${label}: duplicate rank ${bucket.rank}`);
        } else {
          ranks.add(bucket.rank);
        }
        if (typeof bucket.description !== "string" || bucket.description.length === 0) {
          findings.push(`${label}: description must be a non-empty string`);
        }
        if ("ejection" in bucket && typeof bucket.ejection !== "boolean") {
          findings.push(`${label}: ejection must be boolean when present`);
        }
      }
    }

    const ambientIds = new Set();
    if (!Array.isArray(registry.ambients) || registry.ambients.length === 0) {
      findings.push(`${moduleBucketRegistryPath}: ambients must be a non-empty array`);
    } else {
      for (const [index, ambient] of registry.ambients.entries()) {
        const label = `${moduleBucketRegistryPath}:ambients[${index}]`;
        if (!isRecord(ambient)) {
          findings.push(`${label}: ambient must be an object`);
          continue;
        }
        if (typeof ambient.id !== "string" || ambient.id.length === 0) {
          findings.push(`${label}: id must be a non-empty string`);
        } else if (ambientIds.has(ambient.id)) {
          findings.push(`${label}: duplicate id ${ambient.id}`);
        } else {
          ambientIds.add(ambient.id);
        }
        if (!stringArray(ambient.allowedImports)) {
          findings.push(`${label}: allowedImports must be a non-empty string array`);
        }
      }
      for (const [index, ambient] of registry.ambients.entries()) {
        if (!isRecord(ambient) || !Array.isArray(ambient.allowedImports)) continue;
        for (const target of ambient.allowedImports) {
          if (!ambientIds.has(target)) {
            findings.push(
              `${moduleBucketRegistryPath}:ambients[${index}]: allowedImports references unknown ambient ${target}`,
            );
          }
        }
      }
    }

    validateModulePathRules({
      label: "bucketRules",
      rules: registry.bucketRules,
      property: "bucket",
      allowedValues: bucketIds,
      findings,
    });
    validateModulePathRules({
      label: "ambientRules",
      rules: registry.ambientRules,
      property: "ambient",
      allowedValues: ambientIds,
      findings,
    });

    if (!Array.isArray(registry.externalAmbients)) {
      findings.push(`${moduleBucketRegistryPath}: externalAmbients must be an array`);
    } else {
      const seen = new Set();
      for (const [index, rule] of registry.externalAmbients.entries()) {
        const label = `${moduleBucketRegistryPath}:externalAmbients[${index}]`;
        if (!isRecord(rule)) {
          findings.push(`${label}: rule must be an object`);
          continue;
        }
        if (typeof rule.id !== "string" || rule.id.length === 0) {
          findings.push(`${label}: id must be a non-empty string`);
        } else if (seen.has(rule.id)) {
          findings.push(`${label}: duplicate id ${rule.id}`);
        } else {
          seen.add(rule.id);
        }
        if (!moduleSpecifierRuleMatchKinds.has(rule.match)) {
          findings.push(
            `${label}: match must be one of ${[...moduleSpecifierRuleMatchKinds].join(", ")}`,
          );
        }
        if (typeof rule.value !== "string" || rule.value.length === 0) {
          findings.push(`${label}: value must be a non-empty string`);
        }
        if (typeof rule.ambient !== "string" || !ambientIds.has(rule.ambient)) {
          findings.push(`${label}: ambient must reference a declared ambient`);
        }
      }
    }

    if (!isRecord(registry.reportMode)) {
      findings.push(`${moduleBucketRegistryPath}: reportMode object is required`);
    } else {
      if (
        typeof registry.reportMode.enforcement !== "string" ||
        registry.reportMode.enforcement.length === 0
      ) {
        findings.push(
          `${moduleBucketRegistryPath}: reportMode.enforcement must be a non-empty string`,
        );
      }
      if (!stringArray(registry.reportMode.findingKinds)) {
        findings.push(
          `${moduleBucketRegistryPath}: reportMode.findingKinds must be a non-empty string array`,
        );
      } else {
        for (const kind of registry.reportMode.findingKinds) {
          if (!moduleBucketFindingKinds.has(kind)) {
            findings.push(
              `${moduleBucketRegistryPath}: reportMode.findingKinds contains unknown kind ${kind}`,
            );
          }
        }
      }
    }
    return findings;
  };

  const distributionRootsRegistryPath = "architecture/distribution-roots.json";
  const packageUnitsRegistryPath = "architecture/package-units.json";

  const architectureStringRecordArray = (value) =>
    Array.isArray(value) && value.every((entry) => isRecord(entry));

  const validateStringRefs = ({ label, values, allowed, noun, findings }) => {
    if (!stringArray(values)) {
      findings.push(`${label}: must be a non-empty string array`);
      return;
    }
    for (const value of values) {
      if (!allowed.has(value)) findings.push(`${label}: unknown ${noun} ${value}`);
    }
  };

  const validatePeerEntries = ({ label, peers, findings }) => {
    if (!Array.isArray(peers)) {
      findings.push(`${label}: requiredPeers must be an array`);
      return;
    }
    for (const [index, peer] of peers.entries()) {
      const peerLabel = `${label}.requiredPeers[${index}]`;
      if (!isRecord(peer)) {
        findings.push(`${peerLabel}: peer must be an object`);
        continue;
      }
      if (typeof peer.name !== "string" || peer.name.length === 0) {
        findings.push(`${peerLabel}: name must be a non-empty string`);
      }
      if (typeof peer.range !== "string" || peer.range.length === 0) {
        findings.push(`${peerLabel}: range must be a non-empty string`);
      }
    }
  };

  const expectedPublicPackageNameForSource = (sourcePackageName) =>
    typeof sourcePackageName === "string" && sourcePackageName.startsWith("@agent-os/")
      ? `@yansirplus/${sourcePackageName.slice("@agent-os/".length)}`
      : undefined;

  const packageUnitsRegistryFindings = ({
    registry,
    bucketIds,
    ambientIds,
    targetProfileIds = new Set(),
    workspacePackageRecordsByName = new Map(),
  }) => {
    const findings = [];
    if (!isRecord(registry)) return [`${packageUnitsRegistryPath}: registry must be a JSON object`];
    if (registry.schemaVersion !== 1) {
      findings.push(`${packageUnitsRegistryPath}: schemaVersion must be 1`);
    }
    if (!isRecord(registry.policy)) {
      findings.push(`${packageUnitsRegistryPath}: policy object is required`);
    } else {
      for (const key of ["packageBoundary", "namespaceSplit", "effectPeer"]) {
        if (typeof registry.policy[key] !== "string" || registry.policy[key].length === 0) {
          findings.push(`${packageUnitsRegistryPath}: policy.${key} must be a non-empty string`);
        }
      }
    }
    if (
      !architectureStringRecordArray(registry.packageUnits) ||
      registry.packageUnits.length === 0
    ) {
      findings.push(`${packageUnitsRegistryPath}: packageUnits must be a non-empty object array`);
      return findings;
    }
    const ids = new Set();
    const publicNames = new Set();
    for (const [index, unit] of registry.packageUnits.entries()) {
      const label = `${packageUnitsRegistryPath}:packageUnits[${index}]`;
      if (typeof unit.id !== "string" || unit.id.length === 0) {
        findings.push(`${label}: id must be a non-empty string`);
      } else if (ids.has(unit.id)) {
        findings.push(`${label}: duplicate id ${unit.id}`);
      } else {
        ids.add(unit.id);
      }
      if (
        typeof unit.targetSourcePackageName !== "string" ||
        !unit.targetSourcePackageName.startsWith("@agent-os/")
      ) {
        findings.push(`${label}: targetSourcePackageName must be an @agent-os/* string`);
      }
      if (
        typeof unit.publicPackageName !== "string" ||
        !unit.publicPackageName.startsWith("@yansirplus/")
      ) {
        findings.push(`${label}: publicPackageName must be an @yansirplus/* string`);
      } else if (publicNames.has(unit.publicPackageName)) {
        findings.push(`${label}: duplicate publicPackageName ${unit.publicPackageName}`);
      } else {
        publicNames.add(unit.publicPackageName);
      }
      const expectedPublicPackageName = expectedPublicPackageNameForSource(
        unit.targetSourcePackageName,
      );
      if (
        expectedPublicPackageName !== undefined &&
        unit.publicPackageName !== expectedPublicPackageName
      ) {
        findings.push(
          `${label}: publicPackageName must be ${expectedPublicPackageName}, the @yansirplus projection of ${unit.targetSourcePackageName}`,
        );
      }
      if (typeof unit.status !== "string" || unit.status.length === 0) {
        findings.push(`${label}: status must be a non-empty string`);
      }

      if (!isRecord(unit.hardInstallEnvelope)) {
        findings.push(`${label}: hardInstallEnvelope object is required`);
      } else {
        for (const key of [
          "dependencies",
          "installScripts",
          "nativeArtifacts",
          "packageWideMetadata",
        ]) {
          if (!Array.isArray(unit.hardInstallEnvelope[key])) {
            findings.push(`${label}: hardInstallEnvelope.${key} must be an array`);
          }
        }
        validatePeerEntries({
          label: `${label}:hardInstallEnvelope`,
          peers: unit.hardInstallEnvelope.requiredPeers,
          findings,
        });
      }

      validateStringRefs({
        label: `${label}: runtimeConditions`,
        values: unit.runtimeConditions,
        allowed: ambientIds,
        noun: "ambient",
        findings,
      });
      if (targetProfileIds.size > 0) {
        validateStringRefs({
          label: `${label}: targetProfiles`,
          values: unit.targetProfiles,
          allowed: targetProfileIds,
          noun: "targetProfile",
          findings,
        });
      } else if (!stringArray(unit.targetProfiles)) {
        findings.push(`${label}: targetProfiles must be a non-empty string array`);
      }

      if (!architectureStringRecordArray(unit.publicSubpaths) || unit.publicSubpaths.length === 0) {
        findings.push(`${label}: publicSubpaths must be a non-empty object array`);
        continue;
      }
      const subpaths = new Set();
      for (const [subpathIndex, subpath] of unit.publicSubpaths.entries()) {
        const subpathLabel = `${label}:publicSubpaths[${subpathIndex}]`;
        if (
          typeof subpath.subpath !== "string" ||
          (subpath.subpath !== "." && !subpath.subpath.startsWith("./"))
        ) {
          findings.push(`${subpathLabel}: subpath must be . or ./name`);
        } else if (subpaths.has(subpath.subpath)) {
          findings.push(`${subpathLabel}: duplicate subpath ${subpath.subpath}`);
        } else {
          subpaths.add(subpath.subpath);
        }
        validateStringRefs({
          label: `${subpathLabel}: moduleBuckets`,
          values: subpath.moduleBuckets,
          allowed: bucketIds,
          noun: "bucket",
          findings,
        });
        if ("targetProfiles" in subpath) {
          validateStringRefs({
            label: `${subpathLabel}: targetProfiles`,
            values: subpath.targetProfiles,
            allowed: targetProfileIds,
            noun: "targetProfile",
            findings,
          });
        } else if (Array.isArray(unit.targetProfiles) && unit.targetProfiles.length > 1) {
          findings.push(
            `${subpathLabel}: targetProfiles must be declared when package unit has multiple targetProfiles`,
          );
        }
        if (!Array.isArray(subpath.optionalPeers)) {
          findings.push(`${subpathLabel}: optionalPeers must be an array`);
        } else if (
          !subpath.optionalPeers.every((peer) => typeof peer === "string" && peer.length > 0)
        ) {
          findings.push(`${subpathLabel}: optionalPeers entries must be non-empty strings`);
        }
      }
      const record = workspacePackageRecordsByName.get(unit.targetSourcePackageName);
      if (record !== undefined) {
        const manifestPath = `${record.path}/package.json`;
        if (!fs.existsSync(path.join(repoRoot, manifestPath))) {
          findings.push(`${label}: source package manifest is missing at ${manifestPath}`);
        } else {
          const actualSubpaths = new Set(packageExportSubpaths(readJson(manifestPath)));
          const declaredSubpaths = new Set(
            unit.publicSubpaths
              .filter(isRecord)
              .map((subpath) => subpath.subpath)
              .filter((subpath) => typeof subpath === "string"),
          );
          for (const subpath of [...actualSubpaths].sort(compare)) {
            if (!declaredSubpaths.has(subpath)) {
              findings.push(
                `${label}: publicSubpaths missing package.json export ${unit.targetSourcePackageName}${subpath === "." ? "" : `/${subpath.slice(2)}`}`,
              );
            }
          }
          for (const subpath of [...declaredSubpaths].sort(compare)) {
            if (!actualSubpaths.has(subpath)) {
              findings.push(
                `${label}: publicSubpaths declares non-exported subpath ${String(subpath)}`,
              );
            }
          }
        }
      }
    }
    return findings;
  };

  const distributionRootsRegistryFindings = ({
    registry,
    packageUnitIds,
    ambientIds,
    packageUnitsById = new Map(),
  }) => {
    const findings = [];
    if (!isRecord(registry)) {
      return [`${distributionRootsRegistryPath}: registry must be a JSON object`];
    }
    if (registry.schemaVersion !== 1) {
      findings.push(`${distributionRootsRegistryPath}: schemaVersion must be 1`);
    }
    if (!isRecord(registry.policy)) {
      findings.push(`${distributionRootsRegistryPath}: policy object is required`);
    } else {
      for (const key of ["rootTruth", "dogfoodWitness", "targetSelection"]) {
        if (typeof registry.policy[key] !== "string" || registry.policy[key].length === 0) {
          findings.push(
            `${distributionRootsRegistryPath}: policy.${key} must be a non-empty string`,
          );
        }
      }
    }

    if (!architectureStringRecordArray(registry.roots) || registry.roots.length === 0) {
      findings.push(`${distributionRootsRegistryPath}: roots must be a non-empty object array`);
    } else {
      const ids = new Set();
      for (const [index, root] of registry.roots.entries()) {
        const label = `${distributionRootsRegistryPath}:roots[${index}]`;
        if (typeof root.id !== "string" || root.id.length === 0) {
          findings.push(`${label}: id must be a non-empty string`);
        } else if (ids.has(root.id)) {
          findings.push(`${label}: duplicate id ${root.id}`);
        } else {
          ids.add(root.id);
        }
        if (root.kind !== "public-package") {
          findings.push(`${label}: kind must be public-package`);
        }
        if (typeof root.packageUnit !== "string" || !packageUnitIds.has(root.packageUnit)) {
          findings.push(`${label}: packageUnit must reference a package unit`);
        }
        if (
          typeof root.publicPackageName !== "string" ||
          !root.publicPackageName.startsWith("@yansirplus/")
        ) {
          findings.push(`${label}: publicPackageName must be an @yansirplus/* string`);
        }
        const unit = packageUnitsById.get(root.packageUnit);
        if (
          unit !== undefined &&
          typeof unit.publicPackageName === "string" &&
          root.publicPackageName !== unit.publicPackageName
        ) {
          findings.push(
            `${label}: publicPackageName must equal package unit ${root.packageUnit} publicPackageName ${unit.publicPackageName}`,
          );
        }
        if (typeof root.consumerRoot !== "string" || root.consumerRoot.length === 0) {
          findings.push(`${label}: consumerRoot must be a non-empty string`);
        }
      }
    }

    if (
      !architectureStringRecordArray(registry.targetProfiles) ||
      registry.targetProfiles.length === 0
    ) {
      findings.push(
        `${distributionRootsRegistryPath}: targetProfiles must be a non-empty object array`,
      );
    } else {
      const ids = new Set();
      for (const [index, profile] of registry.targetProfiles.entries()) {
        const label = `${distributionRootsRegistryPath}:targetProfiles[${index}]`;
        if (typeof profile.id !== "string" || profile.id.length === 0) {
          findings.push(`${label}: id must be a non-empty string`);
        } else if (ids.has(profile.id)) {
          findings.push(`${label}: duplicate id ${profile.id}`);
        } else {
          ids.add(profile.id);
        }
        if (typeof profile.ambient !== "string" || !ambientIds.has(profile.ambient)) {
          findings.push(`${label}: ambient must reference a module ambient`);
        }
        validateStringRefs({
          label: `${label}: packageUnits`,
          values: profile.packageUnits,
          allowed: packageUnitIds,
          noun: "packageUnit",
          findings,
        });
        if (!stringArray(profile.selectedSubpaths)) {
          findings.push(`${label}: selectedSubpaths must be a non-empty string array`);
        } else {
          const allowedPublicSpecifiers = new Set();
          const explicitProfileSpecifiers = new Set();
          const explicitUnitPublicSpecifiers = new Set();
          for (const unitId of Array.isArray(profile.packageUnits) ? profile.packageUnits : []) {
            const unit = packageUnitsById.get(unitId);
            if (!isRecord(unit) || typeof unit.publicPackageName !== "string") continue;
            for (const subpath of Array.isArray(unit.publicSubpaths) ? unit.publicSubpaths : []) {
              if (!isRecord(subpath) || typeof subpath.subpath !== "string") continue;
              const specifier =
                subpath.subpath === "."
                  ? unit.publicPackageName
                  : `${unit.publicPackageName}/${subpath.subpath.slice(2)}`;
              allowedPublicSpecifiers.add(specifier);
              if (Array.isArray(subpath.targetProfiles)) {
                explicitUnitPublicSpecifiers.add(specifier);
                if (subpath.targetProfiles.includes(profile.id)) {
                  explicitProfileSpecifiers.add(specifier);
                }
              }
            }
          }
          const selected = new Set(profile.selectedSubpaths);
          for (const expected of explicitProfileSpecifiers) {
            if (!selected.has(expected)) {
              findings.push(
                `${label}: selectedSubpaths is missing ${String(expected)}, which package-units assigns to targetProfile ${profile.id}`,
              );
            }
          }
          for (const specifier of profile.selectedSubpaths) {
            if (allowedPublicSpecifiers.has(specifier)) continue;
            findings.push(
              `${label}: selectedSubpaths includes ${specifier}, which is not exported by the selected packageUnits`,
            );
          }
          for (const specifier of profile.selectedSubpaths) {
            if (
              explicitUnitPublicSpecifiers.has(specifier) &&
              !explicitProfileSpecifiers.has(specifier)
            ) {
              findings.push(
                `${label}: selectedSubpaths includes ${specifier}, which package-units does not assign to targetProfile ${profile.id}`,
              );
            }
          }
        }
        if (!Array.isArray(profile.forbiddenSpecifiers)) {
          findings.push(`${label}: forbiddenSpecifiers must be an array`);
        } else if (
          !profile.forbiddenSpecifiers.every(
            (specifier) => typeof specifier === "string" && specifier.length > 0,
          )
        ) {
          findings.push(`${label}: forbiddenSpecifiers entries must be non-empty strings`);
        }
      }
    }

    if (
      !architectureStringRecordArray(registry.dogfoodRoots) ||
      registry.dogfoodRoots.length === 0
    ) {
      findings.push(
        `${distributionRootsRegistryPath}: dogfoodRoots must be a non-empty object array`,
      );
    } else {
      for (const [index, root] of registry.dogfoodRoots.entries()) {
        const label = `${distributionRootsRegistryPath}:dogfoodRoots[${index}]`;
        for (const key of ["id", "kind", "path", "witnessLevel", "gate"]) {
          if (typeof root[key] !== "string" || root[key].length === 0) {
            findings.push(`${label}: ${key} must be a non-empty string`);
          }
        }
        if (!stringArray(root.requiredCapabilities)) {
          findings.push(`${label}: requiredCapabilities must be a non-empty string array`);
        }
      }
    }
    return findings;
  };

  const moduleBucketFindingsForEdges = (edges) => {
    const findings = [];
    const rankByBucket = moduleBucketRank();
    const importsByAmbient = allowedAmbientImports();
    for (const edge of edges) {
      const fromBucket = moduleBucketForPath(edge.fromFile);
      const toBucket = moduleBucketForPath(edge.toFile);
      const fromRank = rankByBucket.get(fromBucket);
      const toRank = rankByBucket.get(toBucket);
      if (fromRank !== undefined && toRank !== undefined && fromRank < toRank) {
        findings.push({
          kind: "bucket-dag",
          file: edge.fromFile,
          target: edge.toFile,
          specifier: edge.specifier,
          message: `${fromBucket} module imports downstream ${toBucket} module`,
        });
      }

      const fromAmbient = moduleAmbientForPath(edge.fromFile);
      const toAmbient = moduleAmbientForPath(edge.toFile);
      if (!(importsByAmbient.get(fromAmbient) ?? new Set()).has(toAmbient)) {
        findings.push({
          kind: "ambient-dag",
          file: edge.fromFile,
          target: edge.toFile,
          specifier: edge.specifier,
          message: `${fromAmbient} module imports ${toAmbient} module`,
        });
      }
    }
    return findings;
  };

  const moduleBucketExternalFindings = (records) => {
    const findings = [];
    const importsByAmbient = allowedAmbientImports();
    for (const record of records) {
      for (const file of walk(`${record.path}/src`).filter((entry) =>
        /\.(?:ts|tsx|mts|cts)$/u.test(entry),
      )) {
        const source = read(file);
        const ambient = moduleAmbientForPath(file);
        for (const importRecord of importSpecifierRecords(source, file)) {
          const targetAmbient = externalAmbientForSpecifier(importRecord.specifier);
          if (targetAmbient === undefined) continue;
          if ((importsByAmbient.get(ambient) ?? new Set()).has(targetAmbient)) continue;
          findings.push({
            kind: "external-ambient",
            file,
            target: targetAmbient,
            specifier: importRecord.specifier,
            message: `${ambient} module imports ${targetAmbient} external specifier`,
          });
        }
      }
    }
    return findings;
  };

  const moduleProductFindings = (graph) => {
    const ejection = ejectionBuckets();
    const packagePathPrefixes = moduleBucketRegistry().productEjection.packagePathPrefixes;
    return graph.files
      .filter(
        (entry) =>
          packagePathPrefixes.some((prefix) => entry.package.path.startsWith(prefix)) &&
          ejection.has(moduleBucketForPath(entry.file)),
      )
      .map((entry) => ({
        kind: "product-ejection",
        file: entry.file,
        target: "consumer",
        specifier: entry.package.name,
        message: "product bucket module must be ejected from final substrate",
      }));
  };

  const moduleBucketNegativeFixtureFailures = () => {
    const failures = [];
    const edgeFindings = moduleBucketFindingsForEdges([
      {
        fromFile: "packages/core/src/index.ts",
        toFile: "packages/providers/deploy-cloudflare/src/index.ts",
        specifier: "@agent-os/deploy-cloudflare",
      },
      {
        fromFile: "packages/client/src/index.ts",
        toFile: "packages/runtime/src/node/index.ts",
        specifier: "@agent-os/runtime/node",
      },
    ]);
    const edgeKinds = edgeFindings.map((finding) => finding.kind);
    for (const kind of ["bucket-dag", "ambient-dag"]) {
      if (!edgeKinds.includes(kind)) {
        failures.push(`edge negative fixture: expected ${kind}, got ${JSON.stringify(edgeKinds)}`);
      }
    }

    const productFindings = moduleProductFindings({
      files: [
        {
          package: { name: "@agent-os/example", path: "packages/example" },
          file: "packages/example/src/product/widget.ts",
        },
      ],
    });
    if (!productFindings.some((finding) => finding.kind === "product-ejection")) {
      failures.push(
        `product negative fixture: expected product-ejection, got ${JSON.stringify(productFindings)}`,
      );
    }
    return failures;
  };

  const checkModuleBuckets = (args = []) => {
    const reportOnly = args.length === 1 && args[0] === "--report-only";
    const negativeFixtures = args.length === 1 && args[0] === "--negative-fixtures";
    if (!reportOnly && !negativeFixtures && args.length > 0) {
      throw new Error(`module-buckets: unexpected argument(s): ${args.join(" ")}`);
    }
    if (negativeFixtures) {
      failIfAny("module buckets negative fixtures", moduleBucketNegativeFixtureFailures());
      return;
    }
    const records = graphWorkspacePackageRecords(repoRoot).filter(
      (record) => typeof record.name === "string" && record.name.startsWith("@agent-os/"),
    );
    const graph = sourceModuleGraph(repoRoot, records);
    const rawFindings = [
      ...moduleBucketFindingsForEdges(graph.edges),
      ...moduleBucketExternalFindings(records),
      ...moduleProductFindings(graph),
    ];
    const seenFindings = new Set();
    const findings = rawFindings
      .filter((finding) => {
        const key = `${finding.kind}\0${finding.file}\0${finding.target}\0${finding.specifier}\0${finding.message}`;
        if (seenFindings.has(key)) return false;
        seenFindings.add(key);
        return true;
      })
      .sort(
        (left, right) =>
          compare(left.kind, right.kind) ||
          compare(left.file, right.file) ||
          compare(left.specifier, right.specifier),
      );
    const bucketCounts = new Map();
    const ambientCounts = new Map();
    for (const entry of graph.files) {
      const bucket = moduleBucketForPath(entry.file);
      const ambient = moduleAmbientForPath(entry.file);
      bucketCounts.set(bucket, (bucketCounts.get(bucket) ?? 0) + 1);
      ambientCounts.set(ambient, (ambientCounts.get(ambient) ?? 0) + 1);
    }
    const sortedEntries = (counts) =>
      [...counts.entries()].sort(([left], [right]) => compare(left, right));
    const summary = `module buckets report-only: ${findings.length} finding(s); buckets ${JSON.stringify(Object.fromEntries(sortedEntries(bucketCounts)))}; ambients ${JSON.stringify(Object.fromEntries(sortedEntries(ambientCounts)))}`;
    const lines = findings.map(
      (finding) =>
        `${finding.file}: module-buckets:${finding.kind}: ${finding.message} via ${finding.specifier} -> ${finding.target}`,
    );
    if (reportOnly) {
      console.log(summary);
      for (const line of lines) console.log(line);
      return;
    }
    failIfAny("module buckets", lines);
  };

  const architectureSourceFindings = () => {
    const workspacePackageRecords = graphWorkspacePackageRecords(repoRoot).filter(
      (record) => typeof record.name === "string" && record.name.startsWith("@agent-os/"),
    );
    const workspacePackageNames = new Set(workspacePackageRecords.map((record) => record.name));
    const workspacePackageRecordsByName = new Map(
      workspacePackageRecords.map((record) => [record.name, record]),
    );
    const moduleBuckets = moduleBucketRegistry();
    const packageUnits = readJson(packageUnitsRegistryPath);
    const distributionRoots = readJson(distributionRootsRegistryPath);
    const packageUnitsById = new Map(
      Array.isArray(packageUnits.packageUnits)
        ? packageUnits.packageUnits
            .filter(isRecord)
            .map((unit) => [unit.id, unit])
            .filter(([id]) => typeof id === "string")
        : [],
    );
    const bucketIds = new Set(
      Array.isArray(moduleBuckets.buckets) ? moduleBuckets.buckets.map((bucket) => bucket.id) : [],
    );
    const ambientIds = new Set(
      Array.isArray(moduleBuckets.ambients)
        ? moduleBuckets.ambients.map((ambient) => ambient.id)
        : [],
    );
    const packageUnitIds = new Set(
      Array.isArray(packageUnits.packageUnits)
        ? packageUnits.packageUnits.map((unit) => unit.id)
        : [],
    );
    const targetProfileIds = new Set(
      Array.isArray(distributionRoots.targetProfiles)
        ? distributionRoots.targetProfiles.map((profile) => profile.id)
        : [],
    );
    return [
      ...ownerIdRegistryFindings({ registry: ownerIdRegistry(), workspacePackageNames }),
      ...moduleBucketRegistryFindings(moduleBuckets),
      ...packageUnitsRegistryFindings({
        registry: packageUnits,
        bucketIds,
        ambientIds,
        targetProfileIds,
        workspacePackageRecordsByName,
      }),
      ...distributionRootsRegistryFindings({
        registry: distributionRoots,
        packageUnitIds,
        ambientIds,
        packageUnitsById,
      }),
    ];
  };

  const checkArchitectureSources = () => {
    failIfAny("architecture sources", architectureSourceFindings());
  };

  return {
    moduleBucketRegistryPath,
    distributionRootsRegistryPath,
    packageUnitsRegistryPath,
    moduleBucketRegistry,
    moduleBucketForPath,
    moduleAmbientForPath,
    allowedAmbientImports,
    moduleBucketRegistryFindings,
    packageUnitsRegistryFindings,
    distributionRootsRegistryFindings,
    moduleBucketFindingsForEdges,
    moduleBucketNegativeFixtureFailures,
    checkModuleBuckets,
    checkArchitectureSources,
  };
};
