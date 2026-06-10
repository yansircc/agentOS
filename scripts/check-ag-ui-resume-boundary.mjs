#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const adapterPath = "packages/wire-adapters/ag-ui/src/index.ts";
const testPath = "packages/wire-adapters/ag-ui/test/ag-ui.test.ts";

const read = (root, file) => fs.readFileSync(path.join(root, file), "utf8");

const agUiSubmitFunctionBody = (source) => {
  const marker = "export const agUiRunAgentInputToSubmitSpec =";
  const start = source.indexOf(marker);
  if (start === -1) return "";
  const nextExport = source.indexOf("\nexport const", start + marker.length);
  return source.slice(start, nextExport === -1 ? undefined : nextExport);
};

const collectFailures = (root = repoRoot) => {
  const failures = [];
  const adapterSource = read(root, adapterPath);
  const testSource = read(root, testPath);
  const body = agUiSubmitFunctionBody(adapterSource);
  if (body.length === 0) {
    failures.push(`${adapterPath}: missing agUiRunAgentInputToSubmitSpec`);
    return failures;
  }
  if (!/AG-UI resume input cannot be lowered to SubmitSpec\.resume/.test(body)) {
    failures.push(`${adapterPath}: non-empty AG-UI resume input is not rejected`);
  }
  if (/\bagUi\s*:\s*{[\s\S]*?\bresume\s*:/m.test(body)) {
    failures.push(`${adapterPath}: AG-UI resume is still hidden in context.agUi`);
  }
  if (
    !/\.\.\.\(defaults\.resume === undefined \? \{\} : \{ resume: defaults\.resume \}\)/.test(body)
  ) {
    failures.push(`${adapterPath}: runtime defaults.resume is not passed to SubmitSpec.resume`);
  }
  if (!/rejects AG-UI resume input/.test(testSource)) {
    failures.push(`${testPath}: missing rejection test for AG-UI resume input`);
  }
  if (!/passes through runtime resume decisions supplied by defaults/.test(testSource)) {
    failures.push(`${testPath}: missing defaults.resume pass-through test`);
  }
  return failures;
};

const writeFixture = (root, relativePath, source) => {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
};

const validAdapterFixture = `export const agUiRunAgentInputToSubmitSpec = (input, defaults) => {
  if ((input.resume ?? []).length > 0) {
    throw new TypeError("AG-UI resume input cannot be lowered to SubmitSpec.resume; pass a runtime resume decision through defaults.resume");
  }
  return {
    ...(defaults.resume === undefined ? {} : { resume: defaults.resume }),
    context: { agUi: { threadId: input.threadId } },
  };
};

export const next = 1;
`;

const validTestFixture = `
it("rejects AG-UI resume input because it is not a runtime SubmitSpec.resume decision", () => {});
it("passes through runtime resume decisions supplied by defaults", () => {});
`;

const collectSelfTestFailures = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-agui-resume-boundary-"));
  try {
    writeFixture(root, adapterPath, validAdapterFixture);
    writeFixture(root, testPath, validTestFixture);
    const baseline = collectFailures(root);
    if (baseline.length > 0) {
      return [`AG-UI resume boundary positive fixture failed:\n${baseline.join("\n")}`];
    }

    writeFixture(
      root,
      adapterPath,
      validAdapterFixture.replace(
        "context: { agUi: { threadId: input.threadId } },",
        "context: { agUi: { threadId: input.threadId, resume: input.resume ?? [] } },",
      ),
    );
    const rejected = collectFailures(root);
    if (!rejected.some((failure) => failure.includes("context.agUi"))) {
      return [
        `AG-UI resume boundary mutation fixture was not rejected: ${JSON.stringify(rejected)}`,
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
    ? "AG-UI resume boundary self-test passed"
    : "AG-UI resume boundary passed",
);
