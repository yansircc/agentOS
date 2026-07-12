import { spawnSync } from "node:child_process";

export const RELEASE_RECEIPT_PROTOCOL = "agentos-release-receipt@1";
export const RELEASE_FULL_GATE_COMMAND = "pnpm run check:full";

const git = (sourceRoot, args) =>
  spawnSync("git", args, {
    cwd: sourceRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

const gitText = (sourceRoot, args) => {
  const result = git(sourceRoot, args);
  return result.status === 0 ? result.stdout.trim() : undefined;
};

const parseReceipt = (text) => {
  if (typeof text !== "string" || text.length === 0) return undefined;
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

export const releaseTagProjection = (sourceRoot, version) => {
  const name = `v${version}`;
  if (typeof sourceRoot !== "string") {
    return { owner: "git", name, status: "unavailable" };
  }
  const objectType = gitText(sourceRoot, ["cat-file", "-t", `refs/tags/${name}`]);
  if (objectType === undefined) return { owner: "git", name, status: "missing" };
  const commit = gitText(sourceRoot, ["rev-list", "-n", "1", `refs/tags/${name}`]);
  const annotation =
    objectType === "tag"
      ? gitText(sourceRoot, ["for-each-ref", "--format=%(contents)", `refs/tags/${name}`])
      : undefined;
  return {
    owner: "git",
    name,
    status: objectType === "tag" ? "annotated" : "lightweight",
    objectType,
    commit,
    ...(annotation === undefined ? {} : { annotation, receipt: parseReceipt(annotation) }),
  };
};

const names = (values) => values.map((value) => value.packageName ?? value.publicName).sort();

const sameStrings = (left, right) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const receiptPackageRows = (projection) => {
  const artifacts = new Map(
    (projection.artifacts.packages ?? []).map((entry) => [entry.packageName, entry]),
  );
  return (projection.release.packages ?? []).map(({ publicName }) => {
    const artifact = artifacts.get(publicName);
    const npm = projection.npm.packages?.[publicName];
    return {
      name: publicName,
      npmVersion: npm?.status === "resolved" ? npm.distTags?.latest : undefined,
      tarballName: artifact?.packageNameReadback,
      tarballVersion: artifact?.packageVersion,
      tarballSha256: artifact?.actualSha256,
    };
  });
};

export const releaseReceiptCandidate = (projection) => ({
  schema: RELEASE_RECEIPT_PROTOCOL,
  version: projection.release.version,
  sourceCommit: projection.source.head,
  gate: {
    command: RELEASE_FULL_GATE_COMMAND,
    status: "passed",
  },
  installManifestSha256: projection.artifacts.sha256,
  packages: receiptPackageRows(projection),
});

export const releaseTagAdmissionFailures = (projection) => {
  const failures = [];
  const version = projection.release.version;
  if (typeof version !== "string" || version.length === 0) failures.push("release_version_missing");
  if (projection.source.status !== "available") failures.push("source_unavailable");
  if (projection.source.dirty !== false) failures.push("source_not_clean");
  if (typeof projection.source.head !== "string" || projection.source.head === "unknown") {
    failures.push("source_commit_unavailable");
  }
  if (projection.artifacts.status !== "verified") failures.push("artifacts_not_verified");
  if (projection.exportEquivalence.status !== "verified") {
    failures.push("export_equivalence_not_verified");
  }
  if (projection.npm.status !== "checked") failures.push("npm_not_checked");

  const declaredNames = names(projection.release.packages ?? []);
  const artifactNames = names(projection.artifacts.packages ?? []);
  const npmNames = Object.keys(projection.npm.packages ?? {}).sort();
  if (!sameStrings(declaredNames, artifactNames)) failures.push("artifact_package_set_mismatch");
  if (!sameStrings(declaredNames, npmNames)) failures.push("npm_package_set_mismatch");

  const artifactMap = new Map(
    (projection.artifacts.packages ?? []).map((entry) => [entry.packageName, entry]),
  );
  for (const packageName of declaredNames) {
    const artifact = artifactMap.get(packageName);
    if (artifact?.status !== "verified") failures.push(`tarball_not_verified:${packageName}`);
    if (artifact?.packageNameReadback !== packageName)
      failures.push(`tarball_name_mismatch:${packageName}`);
    if (artifact?.packageVersion !== version)
      failures.push(`tarball_version_mismatch:${packageName}`);
    const npm = projection.npm.packages?.[packageName];
    if (npm?.status !== "resolved") failures.push(`npm_unresolved:${packageName}`);
    if (npm?.distTags?.latest !== version) failures.push(`npm_version_mismatch:${packageName}`);
  }
  if (projection.tag.status !== "missing") failures.push("release_tag_already_exists");
  return failures;
};

const canonicalJson = (value) => JSON.stringify(value);

export const releaseReceiptProjection = (projection) => {
  const candidate = releaseReceiptCandidate(projection);
  const failures = [];
  if (projection.tag.status === "missing") {
    return { status: "not_issued", expected: candidate, failures: ["release_tag_missing"] };
  }
  if (projection.tag.status !== "annotated") failures.push("release_tag_not_annotated");
  if (projection.tag.commit !== projection.source.head)
    failures.push("release_tag_commit_mismatch");
  if (projection.tag.receipt === undefined) failures.push("release_receipt_invalid_json");
  if (
    failures.includes("release_tag_not_annotated") ||
    failures.includes("release_receipt_invalid_json")
  ) {
    return { status: "failed", expected: candidate, observed: projection.tag.receipt, failures };
  }
  if (projection.npm.status !== "checked" || projection.artifacts.status !== "verified") {
    if (failures.length > 0) {
      return { status: "failed", expected: candidate, observed: projection.tag.receipt, failures };
    }
    return {
      status: "not_checked",
      expected: candidate,
      observed: projection.tag.receipt,
      failures: [
        ...(projection.npm.status === "checked" ? [] : ["npm_not_checked"]),
        ...(projection.artifacts.status === "verified" ? [] : ["artifacts_not_verified"]),
      ],
    };
  }
  if (
    projection.tag.receipt !== undefined &&
    canonicalJson(projection.tag.receipt) !== canonicalJson(candidate)
  ) {
    failures.push("release_receipt_fact_mismatch");
  }
  return {
    status: failures.length === 0 ? "verified" : "failed",
    expected: candidate,
    observed: projection.tag.receipt,
    failures,
  };
};

export const runReleaseFullGate = (sourceRoot) => {
  const result = spawnSync("pnpm", ["run", "check:full"], {
    cwd: sourceRoot,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`agentos release tag: ${RELEASE_FULL_GATE_COMMAND} failed`);
  }
};

export const createAnnotatedReleaseTag = (sourceRoot, projection) => {
  const failures = releaseTagAdmissionFailures(projection);
  if (failures.length > 0) {
    throw new Error(`agentos release tag: admission failed: ${failures.join(",")}`);
  }
  const receipt = releaseReceiptCandidate(projection);
  const result = git(sourceRoot, [
    "tag",
    "-a",
    projection.tag.name,
    "-m",
    canonicalJson(receipt),
    projection.source.head,
  ]);
  if (result.status !== 0) {
    throw new Error(
      `agentos release tag: git tag failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  const observed = releaseTagProjection(sourceRoot, projection.release.version);
  if (
    observed.status !== "annotated" ||
    observed.commit !== projection.source.head ||
    canonicalJson(observed.receipt) !== canonicalJson(receipt)
  ) {
    throw new Error("agentos release tag: annotated receipt readback mismatch");
  }
  return { tag: observed, receipt };
};
