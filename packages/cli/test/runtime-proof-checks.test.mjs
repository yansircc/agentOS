import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import {
  backendNeutralProductionRuntimeProof,
  backendNeutralProductionRuntimeProofFailures,
  backendProviderAxisFailures,
  nodePostgresRuntimeImportBoundaryFailures,
  productionRuntimeProofCommandSpecs,
} from "../src/check/algorithmic/runtime-proof-checks.mjs";

const withFixture = (run) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-runtime-proof-"));
  const write = (relativePath, content) => {
    const file = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
  const readJson = (relativePath) => JSON.parse(read(relativePath));
  const walk = (relativePath) => {
    const absolute = path.join(root, relativePath);
    if (!fs.existsSync(absolute)) return [];
    if (fs.statSync(absolute).isFile()) return [relativePath];
    return fs
      .readdirSync(absolute, { withFileTypes: true })
      .flatMap((entry) => walk(path.join(relativePath, entry.name).split(path.sep).join("/")));
  };
  write(
    "packages/runtime/tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        module: "ESNext",
        moduleResolution: "Bundler",
        target: "ES2022",
        paths: { "@profile/cloudflare": ["./src/cloudflare/index.ts"] },
      },
    }),
  );
  try {
    return run({ root, write, read, readJson, walk });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

const productionRuntimeProofFailures = ({ root, read, readJson }) =>
  backendNeutralProductionRuntimeProofFailures({
    fs,
    path,
    ts,
    repoRoot: root,
    read,
    readJson,
  });

const seedProfiles = ({ write }) => {
  write(
    "package.json",
    JSON.stringify({
      agentos: {
        backendNeutrality: {
          productionRuntimeProfiles: [
            {
              id: "cloudflare-worker",
              sourcePackageName: "@agent-os/runtime",
              subpath: "@agent-os/runtime/cloudflare",
              contractTest:
                "packages/runtime/test/cloudflare/backend-protocol-contract.runtime.test.ts",
            },
            {
              id: "node",
              sourcePackageName: "@agent-os/runtime",
              subpath: "@agent-os/runtime/node",
              contractTest: "packages/runtime/test/node/backend-protocol-contract.runtime.test.ts",
            },
          ],
        },
      },
    }),
  );
  write(
    "packages/runtime/package.json",
    JSON.stringify({
      exports: {
        ".": { types: "./src/index.ts", default: "./src/index.ts" },
        "./cloudflare": {
          types: "./src/cloudflare/index.ts",
          default: "./src/cloudflare/index.ts",
        },
        "./node": { types: "./src/node/index.ts", default: "./src/node/index.ts" },
      },
    }),
  );
  write("packages/runtime/src/index.ts", 'export { neutral } from "./neutral";\n');
  write("packages/runtime/src/neutral.ts", "export const neutral = true;\n");
  write(
    "packages/runtime/src/cloudflare/index.ts",
    "export const createCloudflareDriver = () => ({}) as never;\n",
  );
  write(
    "packages/runtime/src/node/index.ts",
    "export const createNodeDriver = () => ({}) as never;\n",
  );
  write(
    "packages/runtime/test/backend-conformance-registrar.ts",
    "export const VITEST_BACKEND_CONFORMANCE_REGISTRAR = {} as never;\n",
  );
  write(
    "packages/core/src/backend-protocol/conformance.ts",
    [
      "export const BACKEND_CONFORMANCE_LAW_ID = {",
      '  LEDGER_READ_PREFIX: "ledger.read-prefix",',
      '  RESOURCE_RESERVATION: "resource.reservation",',
      '  RESERVED_FUTURE_LAW: "reserved.future-law",',
      "} as const;",
      "const law = (...args: unknown[]) => args;",
      "export const BACKEND_CONFORMANCE_LAWS = [",
      "  law(BACKEND_CONFORMANCE_LAW_ID.LEDGER_READ_PREFIX),",
      "  law(BACKEND_CONFORMANCE_LAW_ID.RESOURCE_RESERVATION),",
      "] as const;",
      "",
    ].join("\n"),
  );
};

void test("backend provider proof follows the neutral import graph transitively", () =>
  withFixture(({ root, write, read, readJson, walk }) => {
    seedProfiles({ write });
    assert.deepEqual(
      backendProviderAxisFailures({ fs, path, ts, repoRoot: root, read, readJson, walk }),
      [],
    );
    write("packages/runtime/src/neutral.ts", 'export { node } from "./node/index";\n');
    assert.ok(
      backendProviderAxisFailures({ fs, path, ts, repoRoot: root, read, readJson, walk }).some(
        (failure) => failure.includes("neutral runtime root graph reaches production profile"),
      ),
    );
    write(
      "packages/runtime/src/neutral.ts",
      'export { cloudflareInternals } from "@agent-os/runtime/cloudflare/internal";\n',
    );
    assert.ok(
      backendProviderAxisFailures({ fs, path, ts, repoRoot: root, read, readJson, walk }).some(
        (failure) =>
          failure.includes("imports production profile @agent-os/runtime/cloudflare/internal"),
      ),
    );
  }));

void test("production profile graphs resolve TypeScript-valid sibling source edges", () =>
  withFixture(({ root, write, read, readJson, walk }) => {
    seedProfiles({ write });
    for (const testCase of [
      {
        label: "extensionless export",
        source: 'export * from "../cloudflare/index";\n',
      },
      {
        label: "JavaScript extension substitution",
        source: 'export * from "../cloudflare/index.js";\n',
      },
      {
        label: "tsconfig path alias",
        source: 'export * from "@profile/cloudflare";\n',
      },
      {
        label: "import type expression",
        source: 'export type PhaseOLeak = import("../cloudflare/index.js").CloudflareType;\n',
      },
    ]) {
      write("packages/runtime/src/node/index.ts", testCase.source);
      assert.ok(
        backendProviderAxisFailures({ fs, path, ts, repoRoot: root, read, readJson, walk }).some(
          (failure) =>
            failure.includes("production profile node reaches cloudflare-worker source axis"),
        ),
        testCase.label,
      );
    }

    for (const testCase of [
      {
        source:
          'const sibling = "../cloudflare/index.js";\nexport const load = () => import(sibling);\n',
        marker: "runtime dynamic import specifier must be a string literal",
      },
      {
        source: 'export const load = () => require("../cloudflare/index.js");\n',
        marker: "runtime module graph forbids CommonJS require",
      },
      {
        source: '/// <reference path="../cloudflare/index.ts" />\nexport const node = true;\n',
        marker: "runtime module graph forbids triple-slash path references",
      },
      {
        source: '/// <reference types="cloudflare:workers" />\nexport const node = true;\n',
        marker: "runtime module graph forbids triple-slash types references",
      },
      {
        source: '/// <reference lib="webworker" />\nexport const node = true;\n',
        marker: "runtime module graph forbids triple-slash lib references",
      },
    ]) {
      write("packages/runtime/src/node/index.ts", testCase.source);
      assert.ok(
        backendProviderAxisFailures({ fs, path, ts, repoRoot: root, read, readJson, walk }).some(
          (failure) => failure.includes(testCase.marker),
        ),
        testCase.marker,
      );
    }

    write(
      "packages/runtime/test/phase-o-adapter.d.ts",
      "export declare const phaseOAdapter: true;\n",
    );
    write(
      "packages/runtime/test/phase-o-adapter.js",
      'export * from "../src/cloudflare/index.js";\n',
    );
    write("packages/runtime/src/node/index.ts", 'export * from "../../test/phase-o-adapter.js";\n');
    assert.ok(
      backendProviderAxisFailures({ fs, path, ts, repoRoot: root, read, readJson, walk }).some(
        (failure) =>
          failure.includes("repo-local dependency") && failure.includes("phase-o-adapter.d.ts"),
      ),
    );

    write(
      "packages/runtime/test/phase-o-profile-bridge.ts",
      'export * from "../src/cloudflare/index.js";\n',
    );
    write(
      "packages/runtime/src/node/index.ts",
      'export * from "../../test/phase-o-profile-bridge.js";\n',
    );
    assert.ok(
      backendProviderAxisFailures({ fs, path, ts, repoRoot: root, read, readJson, walk }).some(
        (failure) =>
          failure.includes("production profile node reaches cloudflare-worker source axis"),
      ),
    );

    write("packages/runtime/src/node/adapter.d.ts", "export declare const adapter: true;\n");
    write("packages/runtime/src/node/adapter.js", "export const adapter = true;\n");
    assert.ok(
      backendProviderAxisFailures({ fs, path, ts, repoRoot: root, read, readJson, walk }).some(
        (failure) => failure.includes("runtime source graph must contain only implementation .ts"),
      ),
    );
  }));

void test("backend proofs fail closed without profiles and validate both export conditions", () =>
  withFixture(({ root, write, read, readJson, walk }) => {
    seedProfiles({ write });
    const rootPackage = readJson("package.json");
    rootPackage.agentos.backendNeutrality.productionRuntimeProfiles = [];
    write("package.json", JSON.stringify(rootPackage));
    assert.ok(
      backendProviderAxisFailures({ fs, path, ts, repoRoot: root, read, readJson, walk }).some(
        (failure) => failure.includes("at least one production runtime profile"),
      ),
    );
    assert.ok(
      productionRuntimeProofFailures({ root, read, readJson }).some((failure) =>
        failure.includes("at least one production runtime profile"),
      ),
    );

    seedProfiles({ write });
    const unsafeRootPackage = readJson("package.json");
    unsafeRootPackage.agentos.backendNeutrality.productionRuntimeProfiles[1].contractTest =
      "packages/runtime/test/../../package.json";
    write("package.json", JSON.stringify(unsafeRootPackage));
    assert.ok(
      productionRuntimeProofFailures({ root, read, readJson }).some((failure) =>
        failure.includes("contract test must be the canonical runtime test for node"),
      ),
    );

    unsafeRootPackage.agentos.backendNeutrality.productionRuntimeProfiles[1].contractTest =
      "packages/runtime/test/in-memory/backend-protocol-contract.test.ts";
    write("package.json", JSON.stringify(unsafeRootPackage));
    assert.ok(
      productionRuntimeProofFailures({ root, read, readJson }).some((failure) =>
        failure.includes("contract test must be the canonical runtime test for node"),
      ),
    );

    seedProfiles({ write });
    const runtimePackage = readJson("packages/runtime/package.json");
    runtimePackage.exports["./node"].types = "./src/cloudflare/index.ts";
    write("packages/runtime/package.json", JSON.stringify(runtimePackage));
    assert.ok(
      backendProviderAxisFailures({ fs, path, ts, repoRoot: root, read, readJson, walk }).some(
        (failure) => failure.includes("export ./node types must stay under ./src/node"),
      ),
    );

    runtimePackage.exports["./node"].types = "./src/node/index.ts";
    runtimePackage.exports["./node"].default = "./src/cloudflare/index.ts";
    write("packages/runtime/package.json", JSON.stringify(runtimePackage));
    assert.ok(
      backendProviderAxisFailures({ fs, path, ts, repoRoot: root, read, readJson, walk }).some(
        (failure) => failure.includes("export ./node default must stay under ./src/node"),
      ),
    );

    runtimePackage.exports["./node"].default = "./src/node/index.ts";
    runtimePackage.exports["./node"].import = "./src/cloudflare/index.ts";
    write("packages/runtime/package.json", JSON.stringify(runtimePackage));
    assert.ok(
      backendProviderAxisFailures({ fs, path, ts, repoRoot: root, read, readJson, walk }).some(
        (failure) => failure.includes("export ./node must contain exactly types and default"),
      ),
    );

    delete runtimePackage.exports["./node"].import;

    runtimePackage.exports["./node"] = {
      types: "./src/node/phase-o-missing.ts",
      default: "./src/node/phase-o-missing.ts",
    };
    write("packages/runtime/package.json", JSON.stringify(runtimePackage));
    const missingTargetFailures = backendProviderAxisFailures({
      fs,
      path,
      ts,
      repoRoot: root,
      read,
      readJson,
      walk,
    });
    assert.equal(
      missingTargetFailures.filter((failure) => failure.includes("target is missing")).length,
      2,
    );
    assert.ok(
      missingTargetFailures.some((failure) =>
        failure.includes("export ./node types must stay under ./src/node at expected entrypoint"),
      ),
    );
    assert.ok(
      missingTargetFailures.some((failure) =>
        failure.includes("export ./node default must stay under ./src/node at expected entrypoint"),
      ),
    );
  }));

void test("backend profile exports cannot escape the runtime package through symlinks", () =>
  withFixture(({ root, write, read, readJson, walk }) => {
    seedProfiles({ write });
    write("external-node-entry.ts", "export const escaped = true;\n");
    const entrypoint = path.join(root, "packages/runtime/src/node/index.ts");
    fs.unlinkSync(entrypoint);
    fs.symlinkSync(path.join(root, "external-node-entry.ts"), entrypoint);
    const failures = backendProviderAxisFailures({
      fs,
      path,
      ts,
      repoRoot: root,
      read,
      readJson,
      walk,
    });
    assert.equal(
      failures.filter((failure) => failure.includes("escapes packages/runtime")).length,
      2,
    );
  }));

void test("backend profile exports reject physical aliases inside the runtime package", () =>
  withFixture(({ root, write, read, readJson, walk }) => {
    seedProfiles({ write });
    write("packages/runtime/src/node-alias.ts", "export const aliased = true;\n");
    const entrypoint = path.join(root, "packages/runtime/src/node/index.ts");
    fs.unlinkSync(entrypoint);
    fs.symlinkSync(path.join(root, "packages/runtime/src/node-alias.ts"), entrypoint);
    const failures = backendProviderAxisFailures({
      fs,
      path,
      ts,
      repoRoot: root,
      read,
      readJson,
      walk,
    });
    assert.equal(
      failures.filter((failure) => failure.includes("must resolve to its declared source axis"))
        .length,
      2,
    );
  }));

void test("production profile subpaths use a closed segment grammar", () =>
  withFixture(({ root, write, read, readJson, walk }) => {
    seedProfiles({ write });
    const initial = readJson("package.json");
    for (const subpath of [
      "@agent-os/runtime/../escape",
      "@agent-os/runtime/node//escape",
      "@agent-os/runtime/node\\escape",
    ]) {
      const rootPackage = structuredClone(initial);
      rootPackage.agentos.backendNeutrality.productionRuntimeProfiles[1].subpath = subpath;
      write("package.json", JSON.stringify(rootPackage));
      assert.ok(
        backendProviderAxisFailures({ fs, path, ts, repoRoot: root, read, readJson, walk }).some(
          (failure) => failure.includes("must name a safe explicit @agent-os/runtime subpath"),
        ),
        subpath,
      );
      assert.ok(
        productionRuntimeProofFailures({ root, read, readJson }).some((failure) =>
          failure.includes("must name a safe explicit @agent-os/runtime subpath"),
        ),
        subpath,
      );
    }
  }));

void test("production profile ids are unique identities", () =>
  withFixture(({ root, write, read, readJson, walk }) => {
    seedProfiles({ write });
    const rootPackage = readJson("package.json");
    rootPackage.agentos.backendNeutrality.productionRuntimeProfiles[1].id = "cloudflare-worker";
    write("package.json", JSON.stringify(rootPackage));
    for (const failures of [
      backendProviderAxisFailures({ fs, path, ts, repoRoot: root, read, readJson, walk }),
      productionRuntimeProofFailures({ root, read, readJson }),
    ]) {
      assert.ok(failures.some((failure) => failure.includes("duplicate production profile id")));
    }
  }));

void test("production profile proof requires the shared registrar import and call", () =>
  withFixture(({ root, write, read, readJson }) => {
    seedProfiles({ write });
    const valid = ({ label, factory, suffix, creator, aliased = false }) => {
      const suite = aliased ? "registerSuite" : "registerBackendConformanceSuite";
      const driver = aliased ? "ContractDriver" : "RuntimeBackendContractDriver";
      const registrar = aliased ? "testRegistrar" : "VITEST_BACKEND_CONFORMANCE_REGISTRAR";
      const owner = aliased ? "runtimeOwner" : "RUNTIME_FACT_OWNER";
      return [
        `import { registerBackendConformanceSuite${aliased ? " as registerSuite" : ""}, type RuntimeBackendContractDriver${aliased ? " as ContractDriver" : ""} } from "@agent-os/runtime/testing";`,
        `import { RUNTIME_FACT_OWNER${aliased ? " as runtimeOwner" : ""} } from "@agent-os/core/runtime-protocol";`,
        `import { VITEST_BACKEND_CONFORMANCE_REGISTRAR${aliased ? " as testRegistrar" : ""} } from "../backend-conformance-registrar";`,
        `import { ${creator} } from "../../src/${suffix}";`,
        `const ${factory} = (): ${driver} => ${creator}();`,
        `${suite}(${registrar}, "${label}", ${factory}, { runtimeFactOwner: ${owner} });`,
        "",
      ].join("\n");
    };
    write(
      "packages/runtime/test/cloudflare/backend-protocol-contract.runtime.test.ts",
      valid({
        label: "cloudflare-do",
        factory: "cloudflareFactory",
        suffix: "cloudflare",
        creator: "createCloudflareDriver",
      }),
    );
    write(
      "packages/runtime/test/node/backend-protocol-contract.runtime.test.ts",
      valid({
        label: "node-postgres",
        factory: "nodeFactory",
        suffix: "node",
        creator: "createNodeDriver",
        aliased: true,
      }),
    );
    assert.deepEqual(productionRuntimeProofFailures({ root, read, readJson }), []);
    write(
      "packages/runtime/test/node/backend-protocol-contract.runtime.test.ts",
      'import { registerBackendConformanceSuite } from "@agent-os/runtime/testing";\n',
    );
    assert.ok(
      productionRuntimeProofFailures({ root, read, readJson }).some((failure) =>
        failure.includes("must register the shared backend conformance suite"),
      ),
    );
  }));

void test("production profile proof rejects dead, duplicate, and malformed registrar calls", () =>
  withFixture(({ root, write, read, readJson }) => {
    seedProfiles({ write });
    const prefix = (factory, suffix = "node", creator = "createNodeDriver") =>
      [
        'import { registerBackendConformanceSuite, type RuntimeBackendContractDriver } from "@agent-os/runtime/testing";',
        'import { RUNTIME_FACT_OWNER } from "@agent-os/core/runtime-protocol";',
        'import { VITEST_BACKEND_CONFORMANCE_REGISTRAR } from "../backend-conformance-registrar";',
        `import { ${creator} } from "../../src/${suffix}";`,
        `const ${factory} = (): RuntimeBackendContractDriver => ${creator}();`,
      ].join("\n");
    const call = (
      label,
      factory,
      args = `VITEST_BACKEND_CONFORMANCE_REGISTRAR, "${label}", ${factory}, { runtimeFactOwner: RUNTIME_FACT_OWNER }`,
    ) => `registerBackendConformanceSuite(${args});\n`;
    const cloudflare = `${prefix(
      "cloudflareFactory",
      "cloudflare",
      "createCloudflareDriver",
    )}\n${call("cloudflare-do", "cloudflareFactory")}`;
    write("packages/runtime/test/cloudflare/backend-protocol-contract.runtime.test.ts", cloudflare);

    const cases = [
      {
        source: `${prefix("nodeFactory")}\nif (false) ${call("node-postgres", "nodeFactory")}`,
        marker: "exactly once as a top-level call",
      },
      {
        source: `${prefix("nodeFactory")}\n${call("node-postgres", "nodeFactory")}${call("node-postgres-duplicate", "nodeFactory")}`,
        marker: "exactly once as a top-level call",
      },
      {
        source: `${prefix("nodeFactory")}\nconst registrar = { describe() {}, law() {} };\n${call("node-postgres", "nodeFactory", 'registrar, "node-postgres", nodeFactory, { runtimeFactOwner: RUNTIME_FACT_OWNER }')}`,
        marker: "must import VITEST_BACKEND_CONFORMANCE_REGISTRAR",
      },
      {
        source: `${prefix("nodeFactory")}\nimport { VITEST_BACKEND_CONFORMANCE_REGISTRAR as wrongRegistrar } from "./fixture";\n${call("node-postgres", "nodeFactory", 'wrongRegistrar, "node-postgres", nodeFactory, { runtimeFactOwner: RUNTIME_FACT_OWNER }')}`,
        marker: "canonical test registrar",
      },
      {
        source: `${prefix("nodeFactory")}\n${call("node-postgres", "nodeFactory", 'VITEST_BACKEND_CONFORMANCE_REGISTRAR, "", nodeFactory, { runtimeFactOwner: RUNTIME_FACT_OWNER }')}`,
        marker: "label must use the closed profile label grammar",
      },
      {
        source: `${prefix("nodeFactory")}\n${call("node-postgres", "nodeFactory", 'VITEST_BACKEND_CONFORMANCE_REGISTRAR, ".*", nodeFactory, { runtimeFactOwner: RUNTIME_FACT_OWNER }')}`,
        marker: "label must use the closed profile label grammar",
      },
      {
        source: `${prefix("nodeFactory")}\n${call("node-postgres", "nodeFactory", 'VITEST_BACKEND_CONFORMANCE_REGISTRAR, "node-postgres", unknownFactory, { runtimeFactOwner: RUNTIME_FACT_OWNER }')}`,
        marker: "factory must be a local function",
      },
      {
        source: `${prefix("nodeFactory")}\nimport { importedFactory } from "./fixture";\n${call("node-postgres", "importedFactory")}`,
        marker: "factory must be a local function",
      },
      {
        source: `${prefix("nodeFactory")}\n${call("node-postgres", "nodeFactory", 'VITEST_BACKEND_CONFORMANCE_REGISTRAR, "node-postgres", nodeFactory, { storageErrorTag: "sql" }')}`,
        marker: "must import RUNTIME_FACT_OWNER",
      },
      {
        source: `${prefix("nodeFactory")}\nconst unknownOwner = "runtime";\n${call("node-postgres", "nodeFactory", 'VITEST_BACKEND_CONFORMANCE_REGISTRAR, "node-postgres", nodeFactory, { runtimeFactOwner: unknownOwner }')}`,
        marker: "must import RUNTIME_FACT_OWNER",
      },
      {
        source: `${prefix("nodeFactory")}\n${call("node-postgres", "nodeFactory", 'VITEST_BACKEND_CONFORMANCE_REGISTRAR, "node-postgres", nodeFactory')}`,
        marker: "requires four arguments",
      },
    ];

    for (const testCase of cases) {
      write(
        "packages/runtime/test/node/backend-protocol-contract.runtime.test.ts",
        testCase.source,
      );
      assert.ok(
        productionRuntimeProofFailures({ root, read, readJson }).some((failure) =>
          failure.includes(testCase.marker),
        ),
        testCase.marker,
      );
    }
  }));

void test("production profile proof executes each canonical shared conformance suite", () =>
  withFixture(({ root, write, read, readJson }) => {
    seedProfiles({ write });
    const contract = ({ label, factory, suffix, factoryBody }) =>
      [
        'import { registerBackendConformanceSuite, type RuntimeBackendContractDriver } from "@agent-os/runtime/testing";',
        'import { RUNTIME_FACT_OWNER } from "@agent-os/core/runtime-protocol";',
        'import { VITEST_BACKEND_CONFORMANCE_REGISTRAR } from "../backend-conformance-registrar";',
        `import { createDriver } from "../../src/${suffix}";`,
        `const ${factory} = (): RuntimeBackendContractDriver => ${factoryBody};`,
        `registerBackendConformanceSuite(VITEST_BACKEND_CONFORMANCE_REGISTRAR, "${label}", ${factory}, { runtimeFactOwner: RUNTIME_FACT_OWNER });`,
        "",
      ].join("\n");
    write(
      "packages/runtime/test/cloudflare/backend-protocol-contract.runtime.test.ts",
      contract({
        label: "cloudflare-do",
        factory: "cloudflareFactory",
        suffix: "cloudflare",
        factoryBody: "createDriver()",
      }),
    );
    write(
      "packages/runtime/test/node/backend-protocol-contract.runtime.test.ts",
      contract({
        label: "node-postgres",
        factory: "nodeFactory",
        suffix: "node",
        factoryBody: "undefined as never",
      }),
    );
    assert.deepEqual(productionRuntimeProofFailures({ root, read, readJson }), []);
    const specs = productionRuntimeProofCommandSpecs({ ts, read, readJson });
    assert.deepEqual(
      specs.map((spec) => spec.argv.slice(-3)),
      [
        [
          "test/cloudflare/backend-protocol-contract.runtime.test.ts",
          "-t",
          "^cloudflare-do backend conformance(?: |$)",
        ],
        [
          "test/node/backend-protocol-contract.runtime.test.ts",
          "-t",
          "^node-postgres backend conformance(?: |$)",
        ],
      ],
    );
    const report = (suiteName, lawIds) =>
      JSON.stringify({
        success: true,
        testResults: [
          {
            assertionResults: lawIds.map((lawId) => ({
              ancestorTitles: [suiteName],
              title: `${lawId}: title`,
              status: "passed",
            })),
          },
        ],
      });
    const writeReport = (args, content) => {
      const outputIndex = args.indexOf("--outputFile");
      assert.ok(outputIndex >= 0);
      fs.writeFileSync(args[outputIndex + 1], content);
      return "non-JSON provider prelude";
    };
    const executed = [];
    assert.throws(
      () =>
        backendNeutralProductionRuntimeProof({
          fs,
          path,
          ts,
          repoRoot: root,
          read,
          readJson,
          execFileSync: (_executable, args) => {
            executed.push(args);
            if (args.includes("test/node/backend-protocol-contract.runtime.test.ts")) {
              throw new Error("no-op driver rejected");
            }
            return writeReport(
              args,
              report("cloudflare-do backend conformance", [
                "ledger.read-prefix",
                "resource.reservation",
              ]),
            );
          },
          failIfAny: (_label, failures) => {
            if (failures.length > 0) throw new Error(failures.join("\n"));
          },
        }),
      /packages\/runtime\/test\/node\/backend-protocol-contract\.runtime\.test\.ts: shared backend conformance execution failed/u,
    );
    assert.equal(executed.length, 2);

    assert.throws(
      () =>
        backendNeutralProductionRuntimeProof({
          fs,
          path,
          ts,
          repoRoot: root,
          read,
          readJson,
          execFileSync: (_executable, args) =>
            writeReport(
              args,
              args.includes("test/cloudflare/backend-protocol-contract.runtime.test.ts")
                ? report("cloudflare-do backend conformance", [
                    "ledger.read-prefix",
                    "resource.reservation",
                  ])
                : report("node-postgres backend conformance", ["ledger.read-prefix"]),
            ),
          failIfAny: (_label, failures) => {
            if (failures.length > 0) throw new Error(failures.join("\n"));
          },
        }),
      /passed law ids do not exactly cover the backend conformance catalog/u,
    );
  }));

void test("node-postgres subpath proof rejects direct and transitive neutral imports", () =>
  withFixture(({ root, write, read, walk }) => {
    write("packages/runtime/src/index.ts", 'export { neutral } from "./neutral";\n');
    write("packages/runtime/src/neutral.ts", "export const neutral = true;\n");
    write("packages/runtime/src/node/index.ts", "export const node = true;\n");
    assert.deepEqual(
      nodePostgresRuntimeImportBoundaryFailures({ fs, path, ts, repoRoot: root, read, walk }),
      [],
    );
    write("packages/runtime/src/neutral.ts", 'export { node } from "./node/index";\n');
    assert.ok(
      nodePostgresRuntimeImportBoundaryFailures({ fs, path, ts, repoRoot: root, read, walk }).some(
        (failure) => failure.includes("crosses the node-postgres subpath boundary"),
      ),
    );
    write(
      "packages/runtime/src/neutral.ts",
      'export { nodeInternals } from "@agent-os/runtime/node/internal";\n',
    );
    assert.ok(
      nodePostgresRuntimeImportBoundaryFailures({ fs, path, ts, repoRoot: root, read, walk }).some(
        (failure) => failure.includes("@agent-os/runtime/node/internal"),
      ),
    );
  }));
