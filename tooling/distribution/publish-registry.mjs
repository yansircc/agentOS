import fs from "node:fs";
import path from "node:path";
import {
  fail,
  isLoopbackRegistry,
  localChannelManifestPath,
  localPackageVersion,
  localRegistryRoot,
  localRegistryUserconfig,
  parseArgs,
  publicPackageName,
  publishAccess,
  publishScope,
  repoPath,
  run,
  withPackageVersion,
  writeJson,
} from "./support.mjs";
import { publishedRecords } from "./package-records.mjs";
import { packInternal, tarballsByPackage } from "./pack-check.mjs";

export const publishInternal = () => {
  packInternal();
  const registry = process.env.AGENTOS_NPM_REGISTRY ?? process.env.NPM_CONFIG_REGISTRY;
  if (registry === undefined || registry.trim().length === 0) {
    fail("AGENTOS_NPM_REGISTRY or NPM_CONFIG_REGISTRY is required for publish:internal");
  }
  const access = publishAccess();
  for (const tarball of tarballsByPackage().values()) {
    run("npm", ["publish", tarball, "--registry", registry, "--access", access]);
  }
};

export const writeLocalChannelManifest = ({ registry, tag, version }) => {
  const names = publishedRecords()
    .map((record) => publicPackageName(record.packageJson.name))
    .sort((left, right) => left.localeCompare(right));
  writeJson(localChannelManifestPath, {
    version,
    registry,
    tag,
    generatedBy: "tooling/distribution/distribution.mjs publish-local",
    dependencies: Object.fromEntries(names.map((name) => [name, tag])),
    npmrc: [`${publishScope()}:registry=${registry}`],
  });
};

export const publishLocal = (rawArgs) => {
  const args = parseArgs(rawArgs);
  const registry =
    args.registry ??
    process.env.AGENTOS_LOCAL_REGISTRY ??
    process.env.AGENTOS_NPM_REGISTRY ??
    "http://127.0.0.1:4873";
  const tag = args.tag ?? process.env.AGENTOS_LOCAL_TAG ?? "agentos-dev";
  const version = args.version ?? localPackageVersion(args.label);
  const access = args.access ?? publishAccess();
  withPackageVersion(version, () => {
    packInternal();
    const userconfig =
      args.userconfig ??
      (isLoopbackRegistry(registry) ? localRegistryUserconfig(registry) : undefined);
    const tarballs = tarballsByPackage();
    for (const [name, tarball] of tarballs.entries()) {
      console.log(`publishing ${name}@${version} to ${registry} with tag ${tag}`);
      const publishArgs = [
        "publish",
        tarball,
        "--registry",
        registry,
        "--tag",
        tag,
        "--access",
        access,
      ];
      if (userconfig !== undefined) publishArgs.push("--userconfig", userconfig);
      run("npm", publishArgs);
    }
    writeLocalChannelManifest({ registry, tag, version });
  });
  console.log(
    `published ${publishedRecords().length} packages to ${registry} with tag ${tag} at version ${version}`,
  );
  console.log(`wrote ${repoPath(localChannelManifestPath)}`);
};

export const localRegistry = (rawArgs) => {
  const args = parseArgs(rawArgs);
  const port = args.port ?? process.env.AGENTOS_LOCAL_REGISTRY_PORT ?? "4873";
  const host = args.host ?? process.env.AGENTOS_LOCAL_REGISTRY_HOST ?? "127.0.0.1";
  const root = localRegistryRoot();
  const storage = path.join(root, "storage");
  const configPath = path.join(root, "config.yaml");
  const htpasswdPath = path.join(root, "htpasswd");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(storage, { recursive: true });
  fs.writeFileSync(htpasswdPath, fs.existsSync(htpasswdPath) ? fs.readFileSync(htpasswdPath) : "");
  fs.writeFileSync(
    configPath,
    [
      `storage: ${storage}`,
      "auth:",
      "  htpasswd:",
      `    file: ${htpasswdPath}`,
      "uplinks:",
      "  npmjs:",
      "    url: https://registry.npmjs.org/",
      "packages:",
      `  '${publishScope()}/*':`,
      "    access: $all",
      "    publish: $all",
      "    unpublish: $all",
      "  '**':",
      "    access: $all",
      "    proxy: npmjs",
      "log:",
      "  - { type: stdout, format: pretty, level: http }",
      "",
    ].join("\n"),
  );
  console.log(`starting local npm registry at http://${host}:${port}`);
  console.log(`storage: ${storage}`);
  run("npm", [
    "exec",
    "--yes",
    "--package",
    "verdaccio@6.7.2",
    "--",
    "verdaccio",
    "--config",
    configPath,
    "--listen",
    `${host}:${port}`,
  ]);
};
