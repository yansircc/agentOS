#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = process.cwd();

const facadePath = "packages/backends/cloudflare-do/src/facade.ts";
const agentDoPath = "packages/backends/cloudflare-do/src/agent-do.ts";
const facadeTypesPath = "packages/backends/cloudflare-do/test/facade-types.ts";

const read = (root, file) => fs.readFileSync(path.join(root, file), "utf8");

const interfaceBlock = (source, name) => {
  const match = source.match(new RegExp(`export interface ${name}[\\s\\S]*?^}`, "m"));
  return match?.[0] ?? "";
};

const collectFailures = (root = repoRoot) => {
  const failures = [];
  const facade = read(root, facadePath);
  const agentDo = read(root, agentDoPath);
  const facadeTypes = read(root, facadeTypesPath);
  const facadeClient = interfaceBlock(facade, "AgentFacadeRuntimeClient");

  if (facadeClient.length === 0) {
    failures.push(`${facadePath}: missing AgentFacadeRuntimeClient interface`);
    return failures;
  }
  if (/AgentFacadeRuntimeClient\s+extends\s+AgentRuntimeReaderClient/.test(facade)) {
    failures.push(`${facadePath}: facade runtime client extends raw reader client`);
  }
  if (/AgentRuntimeReaderClient/.test(facade)) {
    failures.push(`${facadePath}: facade imports or mentions raw reader client`);
  }
  for (const forbidden of [
    "events",
    "streamEvents",
    "projectionGet",
    "projectionList",
    "projectionStatus",
    "projectionRebuild",
    "emitEvent",
    "dispatchToScope",
    "scheduleEvent",
  ]) {
    if (new RegExp(`readonly\\s+${forbidden}\\b`).test(facadeClient)) {
      failures.push(`${facadePath}: facade capability exposes raw method ${forbidden}`);
    }
  }
  if (/AgentEventHandlerContext<\s*Runtime\s+extends\s+AgentRuntimeReaderClient/.test(agentDo)) {
    failures.push(`${agentDoPath}: handler context runtime is constrained to raw reader client`);
  }
  for (const proof of ["agent.events", "agent.streamEvents", "agent.projectionRebuild"]) {
    if (!facadeTypes.includes(proof)) {
      failures.push(`${facadeTypesPath}: missing type-level rejection proof for ${proof}`);
    }
  }
  return failures;
};

const writeFixture = (root, relativePath, source) => {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
};

const writePositiveFixture = (root) => {
  writeFixture(
    root,
    facadePath,
    `export interface AgentFacadeRuntimeClient {
  readonly emit: (event: string, data: unknown) => Promise<{ id: number }>;
  readonly dispatch: (spec: unknown) => Promise<unknown>;
}
`,
  );
  writeFixture(
    root,
    agentDoPath,
    `export interface AgentEventHandlerContext<Runtime = AgentRuntimeClient> {
  readonly runtime: Runtime;
}
`,
  );
  writeFixture(
    root,
    facadeTypesPath,
    `// @ts-expect-error facade handler clients do not expose raw ledger reads
void agent.events({} as never);
// @ts-expect-error facade handler clients do not expose raw event streams
void agent.streamEvents({} as never);
// @ts-expect-error facade handler clients do not expose projection admin
void agent.projectionRebuild({} as never);
`,
  );
};

const collectSelfTestFailures = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-facade-handler-capability-"));
  try {
    writePositiveFixture(root);
    const baseline = collectFailures(root);
    if (baseline.length > 0) {
      return [`facade handler capability positive fixture failed:\n${baseline.join("\n")}`];
    }

    writeFixture(
      root,
      facadePath,
      `export interface AgentRuntimeReaderClient { readonly events: () => void; }
export interface AgentFacadeRuntimeClient extends AgentRuntimeReaderClient {
  readonly emit: (event: string, data: unknown) => Promise<{ id: number }>;
}
`,
    );
    const rejected = collectFailures(root);
    if (!rejected.some((failure) => failure.includes("extends raw reader client"))) {
      return [
        `facade handler capability mutation fixture was not rejected: ${JSON.stringify(rejected)}`,
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
    ? "facade handler capability boundary self-test passed"
    : "facade handler capability boundary passed",
);
