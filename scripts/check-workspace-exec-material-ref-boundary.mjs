#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const workspaceEnvCloudflarePath =
  "packages/execution-domains/workspace-env-cloudflare/src/index.ts";
const workspaceEnvCloudflareTestPath =
  "packages/execution-domains/workspace-env-cloudflare/test/cloudflare-workspace-env.test.ts";
const workspaceSessionCloudflarePath =
  "packages/providers/workspace-session-cloudflare/src/index.ts";
const workspaceSessionCloudflareTestPath =
  "packages/providers/workspace-session-cloudflare/test/cloudflare-workspace-session.test.ts";
const workspaceEnvTestPath = "packages/execution-domains/workspace-env/test/workspace-env.test.ts";

const read = (root, relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

const blockFrom = (source, marker) => {
  const start = source.indexOf(marker);
  if (start === -1) return "";
  const nextConst = source.indexOf("\nconst ", start + marker.length);
  const nextExport = source.indexOf("\nexport ", start + marker.length);
  const candidates = [nextConst, nextExport].filter((index) => index !== -1);
  const end = candidates.length === 0 ? source.length : Math.min(...candidates);
  return source.slice(start, end);
};

const balancedBlockFrom = (source, marker, from = 0) => {
  const start = source.indexOf(marker, from);
  if (start === -1) return "";
  const open = source.indexOf("{", start + marker.length);
  if (open === -1) return "";
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return "";
};

const methodBlockFrom = (source, containerMarker, methodMarker) => {
  const containerStart = source.indexOf(containerMarker);
  if (containerStart === -1) return "";
  return balancedBlockFrom(source, methodMarker, containerStart);
};

const collectFailures = (root = repoRoot) => {
  const failures = [];
  const envCloudflareSource = read(root, workspaceEnvCloudflarePath);
  const envCloudflareTestSource = read(root, workspaceEnvCloudflareTestPath);
  const sessionCloudflareSource = read(root, workspaceSessionCloudflarePath);
  const sessionCloudflareTestSource = read(root, workspaceSessionCloudflareTestPath);
  const workspaceEnvTestSource = read(root, workspaceEnvTestPath);

  const execOrFail = balancedBlockFrom(envCloudflareSource, "const execOrFail = async");
  if (execOrFail.length === 0) {
    failures.push(`${workspaceEnvCloudflarePath}: missing execOrFail`);
  } else {
    if (!/Object\.keys\(options\.envRefs\)\.length > 0/.test(execOrFail)) {
      failures.push(`${workspaceEnvCloudflarePath}: symbolic envRefs are not rejected`);
    }
    if (!/options\.materialRefs\.length > 0/.test(execOrFail)) {
      failures.push(`${workspaceEnvCloudflarePath}: symbolic materialRefs are not rejected`);
    }
    if (!/throw workspaceError\("Cloudflare WorkspaceEnv exec does not resolve symbolic envRefs"\)/.test(execOrFail)) {
      failures.push(`${workspaceEnvCloudflarePath}: envRefs rejection is not a WorkspaceEnv error`);
    }
    if (
      !/throw workspaceError\("Cloudflare WorkspaceEnv exec does not resolve symbolic materialRefs"\)/.test(
        execOrFail,
      )
    ) {
      failures.push(
        `${workspaceEnvCloudflarePath}: materialRefs rejection is not a WorkspaceEnv error`,
      );
    }
    if (/client\.exec\([\s\S]*envRefs|client\.exec\([\s\S]*materialRefs/.test(execOrFail)) {
      failures.push(`${workspaceEnvCloudflarePath}: symbolic refs are still forwarded to exec`);
    }
  }

  if (!/fails closed on symbolic exec refs before invoking Cloudflare exec/.test(envCloudflareTestSource)) {
    failures.push(`${workspaceEnvCloudflareTestPath}: missing Cloudflare WorkspaceEnv ref test`);
  }

  const unsupportedExecRefs = blockFrom(sessionCloudflareSource, "const unsupportedExecRefs =");
  if (unsupportedExecRefs.length === 0) {
    failures.push(`${workspaceSessionCloudflarePath}: missing unsupportedExecRefs`);
  } else {
    if (!/request\.envRefs/.test(unsupportedExecRefs)) {
      failures.push(`${workspaceSessionCloudflarePath}: provider does not inspect envRefs`);
    }
    if (!/request\.materialRefs/.test(unsupportedExecRefs)) {
      failures.push(`${workspaceSessionCloudflarePath}: provider does not inspect materialRefs`);
    }
    if (!/code: "ProviderFailure"/.test(unsupportedExecRefs)) {
      failures.push(`${workspaceSessionCloudflarePath}: unsupported refs are not typed ProviderFailure`);
    }
  }

  const directProviderExec = methodBlockFrom(
    sessionCloudflareSource,
    "export const makeCloudflareWorkspaceSessionProvider",
    "exec: async (request) => {",
  );
  if (!/unsupportedExecRefs\(request\)/.test(directProviderExec)) {
    failures.push(`${workspaceSessionCloudflarePath}: namespace provider exec does not preflight refs`);
  }
  if (/options\.namespace\.get\(request\.sessionRef\)[\s\S]*unsupportedExecRefs\(request\)/.test(directProviderExec)) {
    failures.push(`${workspaceSessionCloudflarePath}: namespace lookup happens before ref rejection`);
  }

  const liveProviderExec = methodBlockFrom(
    sessionCloudflareSource,
    "export const makeCloudflareWorkspaceSessionLiveProvider",
    "exec: async (request) => {",
  );
  if (!/unsupportedExecRefs\(request\)/.test(liveProviderExec)) {
    failures.push(`${workspaceSessionCloudflarePath}: live provider exec does not preflight refs`);
  }
  if (/exec\.call\(client[\s\S]*envRefs|exec\.call\(client[\s\S]*materialRefs/.test(liveProviderExec)) {
    failures.push(`${workspaceSessionCloudflarePath}: symbolic refs are still forwarded to sandbox exec`);
  }

  if (!/fails closed on symbolic exec refs before invoking a Cloudflare namespace client/.test(sessionCloudflareTestSource)) {
    failures.push(`${workspaceSessionCloudflareTestPath}: missing namespace provider ref rejection test`);
  }
  if (!/settles unsupported symbolic exec refs as typed carrier failures/.test(sessionCloudflareTestSource)) {
    failures.push(`${workspaceSessionCloudflareTestPath}: missing carrier typed failure test`);
  }
  if (!/expect\(execCalls\[0\]\?\.options\.envRefs\)\.toEqual/.test(workspaceEnvTestSource)) {
    failures.push(`${workspaceEnvTestPath}: workspace tool no longer passes envRefs to its backend`);
  }
  if (!/expect\(execCalls\[0\]\?\.options\.materialRefs\)\.toEqual/.test(workspaceEnvTestSource)) {
    failures.push(`${workspaceEnvTestPath}: workspace tool no longer passes materialRefs to its backend`);
  }

  return failures;
};

const writeFixture = (root, relativePath, source) => {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
};

const validEnvCloudflareSource = `
const execOrFail = async (client, command, options) => {
  if (options.envRefs !== undefined && Object.keys(options.envRefs).length > 0) {
    throw workspaceError("Cloudflare WorkspaceEnv exec does not resolve symbolic envRefs");
  }
  if (options.materialRefs !== undefined && options.materialRefs.length > 0) {
    throw workspaceError("Cloudflare WorkspaceEnv exec does not resolve symbolic materialRefs");
  }
  return client.exec(command, { cwd: options.cwd });
};
`;

const validEnvCloudflareTestSource = `
it("fails closed on symbolic exec refs before invoking Cloudflare exec", () => {});
`;

const validSessionCloudflareSource = `
const unsupportedExecRefs = (request) => {
  const hasEnvRefs = request.envRefs !== undefined && Object.keys(request.envRefs).length > 0;
  const hasMaterialRefs = request.materialRefs !== undefined && request.materialRefs.length > 0;
  return hasEnvRefs || hasMaterialRefs
    ? { code: "ProviderFailure", reason: "Cloudflare workspace session exec does not resolve symbolic envRefs/materialRefs" }
    : null;
};

export const makeCloudflareWorkspaceSessionProvider = (options) => ({
  exec: async (request) => {
    const refFailure = unsupportedExecRefs(request);
    if (refFailure !== null) return providerRejected(refFailure.reason, refFailure.code);
    const client = await options.namespace.get(request.sessionRef);
    const result = await client.exec(request.command, { cwd: request.cwd, timeoutMs: request.timeoutMs });
    return result;
  },
});

export const makeCloudflareWorkspaceSessionLiveProvider = () => ({
  exec: async (request) => {
    const parsed = parseSessionRef(request.sessionRef, "exec");
    if (isProviderFailure(parsed)) return providerRejected(parsed.reason, parsed.code);
    const refFailure = unsupportedExecRefs(request);
    if (refFailure !== null) return providerRejected(refFailure.reason, refFailure.code);
    const client = await sandboxClient();
    const result = await exec.call(client, request.command, { cwd: request.cwd, timeoutMs: request.timeoutMs });
    return result;
  },
});
`;

const validSessionCloudflareTestSource = `
it("fails closed on symbolic exec refs before invoking a Cloudflare namespace client", () => {});
it.effect("settles unsupported symbolic exec refs as typed carrier failures", () => {});
`;

const validWorkspaceEnvTestSource = `
expect(execCalls[0]?.options.envRefs).toEqual({ TOKEN: "credential:token" });
expect(execCalls[0]?.options.materialRefs).toEqual(["credential:token"]);
`;

const collectSelfTestFailures = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-workspace-exec-ref-boundary-"));
  try {
    writeFixture(root, workspaceEnvCloudflarePath, validEnvCloudflareSource);
    writeFixture(root, workspaceEnvCloudflareTestPath, validEnvCloudflareTestSource);
    writeFixture(root, workspaceSessionCloudflarePath, validSessionCloudflareSource);
    writeFixture(root, workspaceSessionCloudflareTestPath, validSessionCloudflareTestSource);
    writeFixture(root, workspaceEnvTestPath, validWorkspaceEnvTestSource);

    const baseline = collectFailures(root);
    if (baseline.length > 0) {
      return [`workspace exec material ref positive fixture failed:\n${baseline.join("\n")}`];
    }

    writeFixture(
      root,
      workspaceSessionCloudflarePath,
      validSessionCloudflareSource.replace(
        "const refFailure = unsupportedExecRefs(request);\n    if (refFailure !== null) return providerRejected(refFailure.reason, refFailure.code);\n    const client = await options.namespace.get(request.sessionRef);",
        "const client = await options.namespace.get(request.sessionRef);",
      ),
    );
    const rejected = collectFailures(root);
    if (
      !rejected.some((failure) =>
        failure.includes("namespace provider exec does not preflight refs"),
      )
    ) {
      return [
        `workspace exec material ref mutation fixture was not rejected: ${JSON.stringify(rejected)}`,
      ];
    }

    return [];
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

const failures = process.argv.includes("--self-test")
  ? collectSelfTestFailures()
  : collectFailures(repoRoot);

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(
  process.argv.includes("--self-test")
    ? "workspace exec material ref boundary self-test passed"
    : "workspace exec material ref boundary passed",
);
