import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  consumerFacingSpecifierFailuresForContent,
  distributionRootsRegistryFindings,
  distributionEffectPeerFindings,
  distributionFindingsForPackage,
  distributionManifestFindings,
  distributionUnitNegativeFixtureFailures,
  distributionUnitRegistryFindings,
  markdownLinkFailuresForContent,
  packageConstraintNameFailures,
  packageUnitOptionalPeerAllowsEdge,
  packageUnitsRegistryFindings,
} from "../src/check/algorithmic-checks.mjs";
import {
  blueprintRecipeFindingsForSources,
  runtimePublicSurfaceFindings,
} from "../src/check/algorithmic/convergence-smoke-checks.mjs";
import {
  agentCatalogProjectionIssues,
  runtimeSourceFiles,
} from "../../../tooling/distribution/staging-build.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const record = {
  name: "@agent-os/runtime",
  path: "packages/runtime",
};

const runtimeSurface = (entrypoints) => ({
  name: "@agent-os/runtime",
  path: "packages/runtime",
  entrypoints,
});

const runtimePackage = (subpaths) => ({
  exports: Object.fromEntries(subpaths.map((subpath) => [subpath, { default: "./src/index.ts" }])),
});

const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");

const writeFixtureFile = (root, file, text) => {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
  return { path: file, sha256: sha256(text), byteSize: Buffer.byteLength(text) };
};

const agentCatalogFixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-agent-catalog-proof-"));
  const input = writeFixtureFile(root, "docs/surface.json", '{"packages":[]}\n');
  const skill = writeFixtureFile(root, "agent-catalog/agentOS/SKILL.md", "catalog skill\n");
  const packageMap = writeFixtureFile(
    root,
    "agent-catalog/agentOS/references/package-map.md",
    "package map\n",
  );
  writeFixtureFile(
    root,
    "agent-catalog/agentOS/references/provenance.json",
    '{"generated":true}\n',
  );
  const provenance = {
    package: {
      catalogRoot: "agent-catalog/agentOS",
      sourcePackage: "@agent-os/cli",
      publicPackage: "@yansirplus/cli",
      version: "0.5.17",
    },
    inputFiles: [input],
    outputFiles: [skill, packageMap],
  };
  const options = {
    provenance,
    root,
    releaseVersion: "0.5.17",
    publishedSourcePackageNames: new Set(["@agent-os/cli"]),
    publicPackageNameFor: (name) => (name === "@agent-os/cli" ? "@yansirplus/cli" : name),
    provenanceLabel: "fixture provenance",
  };
  return { root, options };
};

const runtimeApiMarkdown = (symbols) =>
  [
    "## Public exports",
    "",
    ...symbols.map((symbol) => `- \`${symbol}\``),
    "",
    "## Experimental exports",
    "",
    "None.",
    "",
    "## Deprecated exports",
    "",
    "None.",
    "",
  ].join("\n");

const lifecycleOwnership = {
  create: "app-or-generated-target",
  reuse: "app-or-generated-target",
  delete: "app-or-generated-target",
  credentials: "app-owned-material",
  network: "app-or-generated-target",
};
const channelBoundary = {
  identity: "agent/channels/<name>.ts",
  inboundRequest: "provider-native-raw-request",
  authority: "verifier-derived-principal",
  outboundSdk: "app-owned",
  deduplication: "app-owned",
  secretHandling: "redacted-before-submit-or-dispatch",
};
const scheduleBoundary = {
  identity: "agent/schedules/<id>.ts",
  timeAuthority: "provider-scheduled-metadata",
  fireIdentity: "stable-app-principal-schedule-id-utc-minute",
  productIngress: "sessions-or-workflows",
  externalSideEffects: "app-owned",
  historyProjection: "schedule-fire-events-plus-linked-product-projections",
};

const blueprintRecipeMarkdown = ({
  id = "provider.material-binding",
  kind = "provider",
  title = "Provider Material Binding",
  primaryFile = "agentos.config.jsonc",
  markerPath = primaryFile,
  ownership = lifecycleOwnership,
  channel = undefined,
  schedule = undefined,
  bodySuffix = "",
} = {}) => {
  const frontmatter = {
    schemaVersion: 1,
    id,
    kind,
    title,
    summary: "Bind product-owned provider material without adding runtime provider code.",
    primaryFile,
    appliesTo: ["agentos add", "agentos update"],
    upgradeGuide: "blueprints/UPGRADE.md",
  };
  if (ownership !== undefined) frontmatter.lifecycleOwnership = ownership;
  if (channel !== undefined) frontmatter.channelBoundary = channel;
  if (schedule !== undefined) frontmatter.scheduleBoundary = schedule;
  return [
    "---json",
    JSON.stringify(frontmatter, null, 2),
    "---",
    `# ${title}`,
    "",
    `<!-- agentos:primary-file path="${markerPath}" -->`,
    "",
    "## Boundary",
    "",
    "The recipe records app-owned integration steps without runtime subpath code.",
    "",
    "## Lifecycle Ownership",
    "",
    "Provider resources are created, reused, deleted, credentialed, and networked outside runtime.",
    "",
    ...(channel === undefined
      ? []
      : [
          "## Channel Boundary",
          "",
          "Inbound channels keep provider-native Request bodies in the handler and use verifier-derived principals for authority.",
          "",
        ]),
    ...(schedule === undefined
      ? []
      : [
          "## Schedule Boundary",
          "",
          "Schedules keep provider scheduled metadata at the generated target and derive history from schedule fire events plus linked product projections.",
          "",
        ]),
    "## Steps",
    "",
    "1. Update the app-owned primary file.",
    "",
    "## Upgrade Guide",
    "",
    "The cumulative upgrade entry owns migration notes.",
    bodySuffix,
  ].join("\n");
};

void test("runtime public surface guard accepts classified stable and host substrate", () => {
  assert.deepEqual(
    runtimePublicSurfaceFindings({
      surfacePackage: runtimeSurface([
        {
          subpath: ".",
          audiences: ["advanced"],
          capability: "runtime algebra",
          surfaceClass: "stable-contract",
        },
        {
          subpath: "./local",
          audiences: ["generated-only", "advanced"],
          capability: "local host substrate",
          surfaceClass: "first-party-host-substrate",
        },
        {
          subpath: "./workspace-binding",
          audiences: ["generated-only"],
          capability: "generated workspace binding",
          surfaceClass: "generated-target-wiring",
        },
        {
          subpath: "./llm-effect-ai/openai-compatible",
          audiences: ["generated-only", "advanced"],
          capability: "OpenAI-compatible transport",
          surfaceClass: "stable-contract",
        },
      ]),
      runtimePackageJson: runtimePackage([
        ".",
        "./local",
        "./workspace-binding",
        "./llm-effect-ai/openai-compatible",
      ]),
    }),
    [],
  );
});

void test("runtime public surface guard rejects unclassified extension-shaped exports", () => {
  const findings = runtimePublicSurfaceFindings({
    surfacePackage: runtimeSurface([
      {
        subpath: ".",
        audiences: ["advanced"],
        capability: "runtime algebra",
        surfaceClass: "stable-contract",
      },
      {
        subpath: "./slack",
        audiences: ["advanced"],
        capability: "Slack channel helper",
      },
    ]),
    runtimePackageJson: runtimePackage([".", "./slack"]),
  });

  assert.equal(
    findings.includes(
      "@agent-os/runtime/slack: runtime surfaceClass must be one of stable-contract, first-party-host-substrate, generated-target-wiring, app-owned-integration-recipe",
    ),
    true,
  );
});

void test("runtime public surface guard rejects blueprint-owned integration as runtime export", () => {
  const findings = runtimePublicSurfaceFindings({
    surfacePackage: runtimeSurface([
      {
        subpath: ".",
        audiences: ["advanced"],
        capability: "runtime algebra",
        surfaceClass: "stable-contract",
      },
      {
        subpath: "./sentry",
        audiences: ["advanced"],
        capability: "Sentry observability helper",
        surfaceClass: "app-owned-integration-recipe",
      },
    ]),
    runtimePackageJson: runtimePackage([".", "./sentry"]),
  });

  assert.equal(
    findings.includes(
      "@agent-os/runtime/sentry: runtime public export cannot be classified app-owned-integration-recipe; keep app-owned integrations in blueprint recipes",
    ),
    true,
  );
  assert.equal(
    findings.includes(
      "@agent-os/runtime/sentry: observability integration-shaped runtime export must be classified as stable substrate, not app-owned-integration-recipe",
    ),
    true,
  );
});

void test("runtime public surface guard requires package exports and surface facts to agree", () => {
  const findings = runtimePublicSurfaceFindings({
    surfacePackage: runtimeSurface([
      {
        subpath: ".",
        audiences: ["advanced"],
        capability: "runtime algebra",
        surfaceClass: "stable-contract",
      },
      {
        subpath: "./local",
        audiences: ["generated-only", "advanced"],
        capability: "local host substrate",
        surfaceClass: "first-party-host-substrate",
      },
    ]),
    runtimePackageJson: runtimePackage([".", "./local", "./discord"]),
  });

  assert.deepEqual(findings, [
    "@agent-os/runtime/discord: runtime package export is missing docs/surface.json entrypoint",
  ]);
});

void test("runtime public surface guard accepts docs-derived cloudflare public barrel symbols", () => {
  assert.deepEqual(
    runtimePublicSurfaceFindings({
      surfacePackage: runtimeSurface([
        {
          subpath: "./cloudflare",
          audiences: ["generated-only", "advanced"],
          capability: "Cloudflare Durable Object runtime adapter",
          surfaceClass: "first-party-host-substrate",
        },
      ]),
      runtimePackageJson: runtimePackage(["./cloudflare"]),
      runtimeApiMarkdown: runtimeApiMarkdown([
        "./cloudflare:AgentRuntimeClient",
        "./cloudflare:createAgentDurableObject",
      ]),
      cloudflarePublicBarrelSource: [
        'export { createAgentDurableObject } from "./agent-do";',
        'export type { AgentRuntimeClient } from "./agent-do";',
      ].join("\n"),
    }),
    [],
  );
});

void test("runtime public surface guard rejects cloudflare public barrel export-star leakage", () => {
  const findings = runtimePublicSurfaceFindings({
    surfacePackage: runtimeSurface([
      {
        subpath: "./cloudflare",
        audiences: ["generated-only", "advanced"],
        capability: "Cloudflare Durable Object runtime adapter",
        surfaceClass: "first-party-host-substrate",
      },
    ]),
    runtimePackageJson: runtimePackage(["./cloudflare"]),
    runtimeApiMarkdown: runtimeApiMarkdown([]),
    cloudflarePublicBarrelSource: 'export * from "./workspace-job-profile";',
  });

  assert.deepEqual(findings, [
    "packages/runtime/src/cloudflare/index.ts:1:1: runtime cloudflare public barrel must use explicit named exports; export-star syntax is forbidden",
  ]);
});

void test("runtime public surface guard rejects cloudflare exports absent from api docs", () => {
  const findings = runtimePublicSurfaceFindings({
    surfacePackage: runtimeSurface([
      {
        subpath: "./cloudflare",
        audiences: ["generated-only", "advanced"],
        capability: "Cloudflare Durable Object runtime adapter",
        surfaceClass: "first-party-host-substrate",
      },
    ]),
    runtimePackageJson: runtimePackage(["./cloudflare"]),
    runtimeApiMarkdown: runtimeApiMarkdown(["./cloudflare:createAgentDurableObject"]),
    cloudflarePublicBarrelSource: [
      'export { createAgentDurableObject } from "./agent-do";',
      'export { installCloudflareWorkspaceJobProfile } from "./workspace-job-profile";',
    ].join("\n"),
  });

  assert.deepEqual(findings, [
    "packages/runtime/src/cloudflare/index.ts: exports ./cloudflare:installCloudflareWorkspaceJobProfile, but docs/api/runtime.md does not declare it",
  ]);
});

void test("runtime public surface guard rejects cloudflare api docs absent from public barrel", () => {
  const findings = runtimePublicSurfaceFindings({
    surfacePackage: runtimeSurface([
      {
        subpath: "./cloudflare",
        audiences: ["generated-only", "advanced"],
        capability: "Cloudflare Durable Object runtime adapter",
        surfaceClass: "first-party-host-substrate",
      },
    ]),
    runtimePackageJson: runtimePackage(["./cloudflare"]),
    runtimeApiMarkdown: runtimeApiMarkdown([
      "./cloudflare:createAgentDurableObject",
      "./cloudflare:createCloudflareWorkspaceEnvResolver",
    ]),
    cloudflarePublicBarrelSource: 'export { createAgentDurableObject } from "./agent-do";',
  });

  assert.deepEqual(findings, [
    "docs/api/runtime.md: declares ./cloudflare:createCloudflareWorkspaceEnvResolver, but packages/runtime/src/cloudflare/index.ts does not export it",
  ]);
});

void test("blueprint recipe contract accepts versioned markdown source", () => {
  assert.deepEqual(
    blueprintRecipeFindingsForSources({
      recipeSources: [
        {
          file: "blueprints/recipes/provider/material-binding.md",
          content: blueprintRecipeMarkdown(),
        },
      ],
      upgradeGuideContent:
        '# Blueprint Upgrade Guide\n\n<!-- agentos:blueprint-upgrade id="provider.material-binding" -->\n',
    }),
    [],
  );
});

void test("blueprint recipe contract accepts channel ingress boundary facts", () => {
  assert.deepEqual(
    blueprintRecipeFindingsForSources({
      recipeSources: [
        {
          file: "blueprints/recipes/channel/inbound.md",
          content: blueprintRecipeMarkdown({
            id: "channel.inbound",
            kind: "channel",
            title: "Inbound Channel Boundary",
            primaryFile: "agent/channels/<name>.ts",
            ownership: undefined,
            channel: channelBoundary,
          }),
        },
      ],
      upgradeGuideContent:
        '# Blueprint Upgrade Guide\n\n<!-- agentos:blueprint-upgrade id="channel.inbound" -->\n',
    }),
    [],
  );
});

void test("blueprint recipe contract accepts schedule time-ingress boundary facts", () => {
  assert.deepEqual(
    blueprintRecipeFindingsForSources({
      recipeSources: [
        {
          file: "blueprints/recipes/schedule/time-ingress.md",
          content: blueprintRecipeMarkdown({
            id: "schedule.time-ingress",
            kind: "schedule",
            title: "Schedule Time Ingress",
            primaryFile: "agent/schedules/<id>.ts",
            ownership: undefined,
            schedule: scheduleBoundary,
          }),
        },
      ],
      upgradeGuideContent:
        '# Blueprint Upgrade Guide\n\n<!-- agentos:blueprint-upgrade id="schedule.time-ingress" -->\n',
    }),
    [],
  );
});

void test("blueprint recipe contract rejects target replacement and marker drift", () => {
  const findings = blueprintRecipeFindingsForSources({
    recipeSources: [
      {
        file: "blueprints/recipes/provider/material-binding.md",
        content: blueprintRecipeMarkdown({
          markerPath: "package.json",
          bodySuffix: "\nDo not create target--node replacement code.",
        }),
      },
      {
        file: "blueprints/recipes/target/node.md",
        content: blueprintRecipeMarkdown({
          id: "target.node",
          kind: "target",
          title: "Node Target Replacement",
        }),
      },
    ],
    upgradeGuideContent:
      '# Blueprint Upgrade Guide\n\n<!-- agentos:blueprint-upgrade id="provider.material-binding" -->\n<!-- agentos:blueprint-upgrade id="unknown.recipe" -->\n',
  });

  assert.equal(
    findings.includes(
      "blueprints/recipes/provider/material-binding.md: primary-file marker must match frontmatter.primaryFile",
    ),
    true,
  );
  assert.equal(
    findings.includes(
      "blueprints/recipes/provider/material-binding.md: blueprint recipe must not reference target--node",
    ),
    true,
  );
  assert.equal(
    findings.includes(
      "blueprints/recipes/target/node.md: kind must be one of channel, schedule, sandbox, database, provider, observability",
    ),
    true,
  );
  assert.equal(
    findings.includes("blueprints/UPGRADE.md: unknown upgrade marker unknown.recipe"),
    true,
  );
});

void test("blueprint recipe contract rejects channel runtime lifecycle drift", () => {
  const findings = blueprintRecipeFindingsForSources({
    recipeSources: [
      {
        file: "blueprints/recipes/channel/inbound.md",
        content: blueprintRecipeMarkdown({
          id: "channel.inbound",
          kind: "channel",
          title: "Inbound Channel Boundary",
          primaryFile: "agent/channels/<name>.ts",
          ownership: undefined,
          channel: {
            ...channelBoundary,
            authority: "provider-payload",
            outboundSdk: "runtime-owned",
          },
          bodySuffix: [
            "",
            'import { WebClient } from "@slack/web-api";',
            "Provider lifecycle code belongs here.",
          ].join("\n"),
        }),
      },
      {
        file: "blueprints/recipes/channel/missing-boundary.md",
        content: blueprintRecipeMarkdown({
          id: "channel.missing-boundary",
          kind: "channel",
          title: "Missing Channel Boundary",
          primaryFile: "agent/channels/<name>.ts",
          ownership: undefined,
        }),
      },
    ],
    upgradeGuideContent:
      '# Blueprint Upgrade Guide\n\n<!-- agentos:blueprint-upgrade id="channel.inbound" -->\n<!-- agentos:blueprint-upgrade id="channel.missing-boundary" -->\n',
  });

  assert.equal(
    findings.includes(
      "blueprints/recipes/channel/inbound.md: channelBoundary.authority must be verifier-derived-principal",
    ),
    true,
  );
  assert.equal(
    findings.includes(
      "blueprints/recipes/channel/inbound.md: channelBoundary.outboundSdk must be app-owned",
    ),
    true,
  );
  assert.equal(
    findings.includes(
      "blueprints/recipes/channel/inbound.md: blueprint recipe must not contain source import statements",
    ),
    true,
  );
  assert.equal(
    findings.includes(
      "blueprints/recipes/channel/missing-boundary.md: channel recipe requires channelBoundary object",
    ),
    true,
  );
});

void test("blueprint recipe contract rejects schedule boundary drift", () => {
  const findings = blueprintRecipeFindingsForSources({
    recipeSources: [
      {
        file: "blueprints/recipes/schedule/time-ingress.md",
        content: blueprintRecipeMarkdown({
          id: "schedule.time-ingress",
          kind: "schedule",
          title: "Schedule Time Ingress",
          primaryFile: "agent/schedules/<id>.ts",
          ownership: undefined,
          schedule: {
            ...scheduleBoundary,
            fireIdentity: "wall-clock-fire-time",
            externalSideEffects: "runtime-owned",
          },
        }),
      },
      {
        file: "blueprints/recipes/schedule/missing-boundary.md",
        content: blueprintRecipeMarkdown({
          id: "schedule.missing-boundary",
          kind: "schedule",
          title: "Missing Schedule Boundary",
          primaryFile: "agent/schedules/<id>.ts",
          ownership: undefined,
        }),
      },
    ],
    upgradeGuideContent:
      '# Blueprint Upgrade Guide\n\n<!-- agentos:blueprint-upgrade id="schedule.time-ingress" -->\n<!-- agentos:blueprint-upgrade id="schedule.missing-boundary" -->\n',
  });

  assert.equal(
    findings.includes(
      "blueprints/recipes/schedule/time-ingress.md: scheduleBoundary.fireIdentity must be stable-app-principal-schedule-id-utc-minute",
    ),
    true,
  );
  assert.equal(
    findings.includes(
      "blueprints/recipes/schedule/time-ingress.md: scheduleBoundary.externalSideEffects must be app-owned",
    ),
    true,
  );
  assert.equal(
    findings.includes(
      "blueprints/recipes/schedule/missing-boundary.md: schedule recipe requires scheduleBoundary object",
    ),
    true,
  );
});

void test("blueprint recipe contract requires provider and sandbox lifecycle ownership facts", () => {
  const findings = blueprintRecipeFindingsForSources({
    recipeSources: [
      {
        file: "blueprints/recipes/provider/material-binding.md",
        content: blueprintRecipeMarkdown({ ownership: null }),
      },
      {
        file: "blueprints/recipes/sandbox/lifecycle-boundary.md",
        content: blueprintRecipeMarkdown({
          id: "sandbox.lifecycle-boundary",
          kind: "sandbox",
          title: "Sandbox Lifecycle Boundary",
          ownership: {
            create: "runtime",
            reuse: "app-or-generated-target",
            delete: "app-or-generated-target",
            credentials: "app-owned-material",
            network: "app-or-generated-target",
          },
        }),
      },
    ],
    upgradeGuideContent:
      '# Blueprint Upgrade Guide\n\n<!-- agentos:blueprint-upgrade id="provider.material-binding" -->\n<!-- agentos:blueprint-upgrade id="sandbox.lifecycle-boundary" -->\n',
  });

  assert.equal(
    findings.includes(
      "blueprints/recipes/provider/material-binding.md: provider recipe requires lifecycleOwnership object",
    ),
    true,
  );
  assert.equal(
    findings.includes(
      "blueprints/recipes/sandbox/lifecycle-boundary.md: lifecycleOwnership.create must be app-or-generated-target",
    ),
    true,
  );
});

void test("blueprint recipe contract rejects provider lifecycle source wiring", () => {
  const findings = blueprintRecipeFindingsForSources({
    recipeSources: [
      {
        file: "blueprints/recipes/provider/material-binding.md",
        content: blueprintRecipeMarkdown({
          bodySuffix: [
            "",
            'import OpenAI from "openai";',
            "createCloudflareWorkspaceEnvResolver();",
          ].join("\n"),
        }),
      },
    ],
    upgradeGuideContent:
      '# Blueprint Upgrade Guide\n\n<!-- agentos:blueprint-upgrade id="provider.material-binding" -->\n',
  });

  assert.equal(
    findings.includes(
      "blueprints/recipes/provider/material-binding.md: blueprint recipe must not contain source import statements",
    ),
    true,
  );
  assert.equal(
    findings.includes(
      "blueprints/recipes/provider/material-binding.md: blueprint recipe must not contain Cloudflare workspace lifecycle helper wiring",
    ),
    true,
  );
});

void test("distribution architecture sources are valid", () => {
  const moduleBuckets = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "architecture/module-buckets.json"), "utf8"),
  );
  const packageUnits = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "architecture/package-units.json"), "utf8"),
  );
  const distributionRoots = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "architecture/distribution-roots.json"), "utf8"),
  );
  const bucketIds = new Set(moduleBuckets.buckets.map((bucket) => bucket.id));
  const ambientIds = new Set(moduleBuckets.ambients.map((ambient) => ambient.id));
  const packageUnitIds = new Set(packageUnits.packageUnits.map((unit) => unit.id));
  const targetProfileIds = new Set(distributionRoots.targetProfiles.map((profile) => profile.id));
  const workspacePackageRecordsByName = new Map(
    ["core", "runtime", "client", "cli"].map((id) => [
      `@agent-os/${id}`,
      { name: `@agent-os/${id}`, path: `packages/${id}` },
    ]),
  );
  const packageUnitsById = new Map(packageUnits.packageUnits.map((unit) => [unit.id, unit]));

  assert.deepEqual(
    packageUnitsRegistryFindings({
      registry: packageUnits,
      bucketIds,
      ambientIds,
      targetProfileIds,
      workspacePackageRecordsByName,
    }),
    [],
  );
  assert.deepEqual(
    distributionRootsRegistryFindings({
      registry: distributionRoots,
      packageUnitIds,
      ambientIds,
      packageUnitsById,
    }),
    [],
  );
});

void test("distribution staging emits public export closure only", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-distribution-closure-"));
  try {
    fs.mkdirSync(path.join(root, "src", "nested"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "src", "index.ts"),
      'export { publicValue } from "./public";\n',
    );
    fs.writeFileSync(
      path.join(root, "src", "public.ts"),
      'import type { PrivateShape } from "./private";\nexport const publicValue: PrivateShape = { ok: true };\n',
    );
    fs.writeFileSync(
      path.join(root, "src", "private.ts"),
      'import { leaf } from "./nested/leaf";\nexport interface PrivateShape { readonly ok: boolean }\nvoid leaf;\n',
    );
    fs.writeFileSync(path.join(root, "src", "nested", "leaf.ts"), "export const leaf = true;\n");
    fs.writeFileSync(path.join(root, "src", "cli.mjs"), 'import "./cli-helper.mjs";\n');
    fs.writeFileSync(path.join(root, "src", "cli-helper.mjs"), "export const cli = true;\n");
    fs.writeFileSync(
      path.join(root, "src", "internal-lifecycle.ts"),
      "export const createCloudflareWorkspaceEnvResolver = () => undefined;\n",
    );

    const files = runtimeSourceFiles({
      packageDir: root,
      packagePath: "packages/fixture",
      packageJson: {
        exports: {
          ".": {
            default: "./src/index.ts",
            types: "./src/index.ts",
          },
        },
        bin: {
          fixture: "./src/cli.mjs",
        },
      },
    }).map((file) => path.relative(root, file).split(path.sep).join("/"));

    assert.deepEqual(
      files,
      [
        "src/cli-helper.mjs",
        "src/cli.mjs",
        "src/index.ts",
        "src/nested/leaf.ts",
        "src/private.ts",
        "src/public.ts",
      ].sort((left, right) => left.localeCompare(right)),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

void test("agent catalog provenance proves installed catalog source and output hashes", () => {
  const { root, options } = agentCatalogFixture();
  try {
    assert.deepEqual(agentCatalogProjectionIssues(options), []);

    const staleInput = { ...options, provenance: structuredClone(options.provenance) };
    staleInput.provenance.inputFiles[0].sha256 = "0".repeat(64);
    assert.match(
      agentCatalogProjectionIssues(staleInput).join("\n"),
      /inputFiles: docs\/surface\.json sha256 mismatch/,
    );

    const missingOutput = { ...options, provenance: structuredClone(options.provenance) };
    missingOutput.provenance.outputFiles = missingOutput.provenance.outputFiles.slice(0, 1);
    assert.match(
      agentCatalogProjectionIssues(missingOutput).join("\n"),
      /outputFiles missing actual catalog file agent-catalog\/agentOS\/references\/package-map\.md/,
    );

    const wrongVersion = { ...options, provenance: structuredClone(options.provenance) };
    wrongVersion.provenance.package.version = "0.5.16";
    assert.match(agentCatalogProjectionIssues(wrongVersion).join("\n"), /package\.version/);

    const wrongOwner = { ...options, provenance: structuredClone(options.provenance) };
    wrongOwner.provenance.package.sourcePackage = "@agent-os/runtime";
    assert.match(
      agentCatalogProjectionIssues(wrongOwner).join("\n"),
      /package\.sourcePackage is not a published package/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

void test("package-unit registry exactness rejects public/export drift", () => {
  const findings = packageUnitsRegistryFindings({
    registry: {
      schemaVersion: 1,
      policy: {
        packageBoundary: "policy",
        namespaceSplit: "policy",
        effectPeer: "policy",
      },
      packageUnits: [
        {
          id: "runtime",
          targetSourcePackageName: "@agent-os/runtime",
          publicPackageName: "@yansirplus/not-runtime",
          status: "target",
          hardInstallEnvelope: {
            dependencies: [],
            installScripts: [],
            nativeArtifacts: [],
            packageWideMetadata: [],
            requiredPeers: [],
          },
          runtimeConditions: ["neutral"],
          targetProfiles: ["neutral"],
          publicSubpaths: [{ subpath: ".", moduleBuckets: ["ledger"], optionalPeers: [] }],
        },
      ],
    },
    bucketIds: new Set(["ledger"]),
    ambientIds: new Set(["neutral"]),
    targetProfileIds: new Set(["neutral"]),
    workspacePackageRecordsByName: new Map([
      ["@agent-os/runtime", { name: "@agent-os/runtime", path: "packages/runtime" }],
    ]),
  });

  assert.equal(
    findings.some((finding) => finding.includes("publicPackageName must be @yansirplus/runtime")),
    true,
  );
  assert.equal(
    findings.some((finding) =>
      finding.includes("publicSubpaths missing package.json export @agent-os/runtime/admission"),
    ),
    true,
  );
});

void test("distribution roots require exact profile coverage for public subpaths", () => {
  const packageUnitsById = new Map([
    [
      "runtime",
      {
        id: "runtime",
        publicPackageName: "@yansirplus/runtime",
        publicSubpaths: [
          { subpath: ".", targetProfiles: ["neutral"] },
          { subpath: "./cloudflare", targetProfiles: ["cloudflare-worker"] },
        ],
      },
    ],
  ]);
  const base = {
    schemaVersion: 1,
    policy: {
      rootTruth: "policy",
      dogfoodWitness: "policy",
      targetSelection: "policy",
    },
    roots: [
      {
        id: "public-runtime",
        kind: "public-package",
        packageUnit: "runtime",
        publicPackageName: "@yansirplus/runtime",
        consumerRoot: "runtime",
      },
    ],
    dogfoodRoots: [
      {
        id: "spike",
        kind: "external-consumer",
        path: "spikes/",
        witnessLevel: "capability",
        gate: "gate",
        requiredCapabilities: ["runtime"],
      },
    ],
  };

  const missing = distributionRootsRegistryFindings({
    registry: {
      ...base,
      targetProfiles: [
        {
          id: "neutral",
          ambient: "neutral",
          packageUnits: ["runtime"],
          selectedSubpaths: ["@yansirplus/runtime"],
          forbiddenSpecifiers: [],
        },
        {
          id: "cloudflare-worker",
          ambient: "cloudflare-worker",
          packageUnits: ["runtime"],
          selectedSubpaths: [],
          forbiddenSpecifiers: [],
        },
      ],
    },
    packageUnitIds: new Set(["runtime"]),
    ambientIds: new Set(["neutral", "cloudflare-worker"]),
    packageUnitsById,
  });
  assert.equal(
    missing.some((finding) =>
      finding.includes(
        "selectedSubpaths is missing @yansirplus/runtime/cloudflare, which package-units assigns to targetProfile cloudflare-worker",
      ),
    ),
    true,
  );

  const wrongProfile = distributionRootsRegistryFindings({
    registry: {
      ...base,
      targetProfiles: [
        {
          id: "neutral",
          ambient: "neutral",
          packageUnits: ["runtime"],
          selectedSubpaths: ["@yansirplus/runtime", "@yansirplus/runtime/cloudflare"],
          forbiddenSpecifiers: [],
        },
      ],
    },
    packageUnitIds: new Set(["runtime"]),
    ambientIds: new Set(["neutral", "cloudflare-worker"]),
    packageUnitsById,
  });
  assert.equal(
    wrongProfile.some((finding) =>
      finding.includes(
        "selectedSubpaths includes @yansirplus/runtime/cloudflare, which package-units does not assign to targetProfile neutral",
      ),
    ),
    true,
  );
});

void test("distribution manifest scanner reports package-wide install obligations", () => {
  const findings = distributionManifestFindings(
    record,
    {
      scripts: {
        install: "node-gyp rebuild",
      },
      dependencies: {
        "@agent-os/core": "workspace:*",
        sharp: "^1.0.0",
      },
      devDependencies: {
        "node-gyp": "^10.0.0",
      },
      engines: {
        node: ">=22",
      },
      os: ["darwin"],
      gypfile: true,
    },
    ["packages/runtime/binding.gyp", "packages/runtime/build/addon.node"],
  );

  assert.deepEqual(
    findings.map((finding) => finding.kind),
    [
      "package-install-script",
      "native-marker",
      "native-marker",
      "native-marker",
      "native-tool-dependency",
      "package-wide-metadata",
      "package-wide-metadata",
      "hard-dependency",
    ],
  );
  assert.equal(findings.find((finding) => finding.kind === "hard-dependency")?.specifier, "sharp");
});

void test("optional peer locality is a subpath fact, not a hard package split", () => {
  const findings = distributionFindingsForPackage({
    record,
    manifest: {
      peerDependencies: {
        react: "^19",
      },
      peerDependenciesMeta: {
        react: {
          optional: true,
        },
      },
      exports: {
        ".": "./src/index.ts",
        "./react": "./src/react.ts",
      },
    },
    sourceByFile: new Map([
      ["packages/runtime/src/index.ts", "export const root = 1;"],
      ["packages/runtime/src/react.ts", 'import { useMemo } from "react"; export { useMemo };'],
    ]),
    edges: [],
  });

  assert.deepEqual(
    findings.map((finding) => [finding.kind, finding.severity, finding.specifier]),
    [
      ["optional-peer", "info", "react"],
      ["optional-peer-locality", "info", "react"],
    ],
  );
});

void test("package import DAG allows only declared subpath optional peer edges", () => {
  const registry = {
    packageUnits: [
      {
        targetSourcePackageName: "@agent-os/runtime",
        publicSubpaths: [
          {
            subpath: ".",
            optionalPeers: [],
          },
          {
            subpath: "./cloudflare",
            optionalPeers: ["@agent-os/sse-http"],
          },
        ],
      },
    ],
  };
  const to = { name: "@agent-os/sse-http", path: "packages/transports/sse-http" };

  assert.equal(
    packageUnitOptionalPeerAllowsEdge({
      registry,
      edge: {
        from: record,
        to,
        file: "packages/runtime/src/cloudflare/ag-ui-sse.ts",
      },
    }),
    true,
  );
  assert.equal(
    packageUnitOptionalPeerAllowsEdge({
      registry,
      edge: {
        from: record,
        to,
        file: "packages/runtime/src/index.ts",
      },
    }),
    false,
  );
  assert.equal(
    packageUnitOptionalPeerAllowsEdge({
      registry,
      edge: {
        from: record,
        to: {
          name: "@agent-os/workspace-env",
          path: "packages/execution-domains/workspace-env",
        },
        file: "packages/runtime/src/index.ts",
      },
    }),
    false,
  );
});

void test("package unit semantics reject root and hard-obligation optional peers", () => {
  const findings = distributionUnitRegistryFindings({
    expectedEffectRange: "^4.0.0",
    registry: {
      packageUnits: [
        {
          id: "client",
          hardInstallEnvelope: {
            dependencies: ["react"],
            installScripts: [],
            nativeArtifacts: [],
            packageWideMetadata: [],
            requiredPeers: [{ name: "effect", range: "^5.0.0" }],
          },
          publicSubpaths: [
            { subpath: ".", optionalPeers: ["react"] },
            { subpath: "./react", optionalPeers: ["react"] },
          ],
        },
      ],
    },
  });

  assert.deepEqual(
    findings.map((finding) => [finding.kind, finding.specifier]),
    [
      ["package-unit-root-optional-peer", "react"],
      ["package-unit-hard-locality", "react"],
      ["package-unit-hard-locality", "react"],
      ["package-unit-effect-peer-invariant", "effect"],
    ],
  );
});

void test("root closure catches value and d.ts optional peer leaks", () => {
  const findings = distributionFindingsForPackage({
    record,
    manifest: {
      peerDependencies: {
        react: "^19",
      },
      peerDependenciesMeta: {
        react: {
          optional: true,
        },
      },
      exports: {
        ".": "./src/index.ts",
        "./react": "./src/react.ts",
      },
    },
    sourceByFile: new Map([
      ["packages/runtime/src/index.ts", 'export type { ReactNode } from "./react";'],
      [
        "packages/runtime/src/react.ts",
        'import type { ReactNode } from "react"; import { useMemo } from "react"; export type { ReactNode }; export { useMemo };',
      ],
    ]),
    edges: [
      {
        from: record,
        to: record,
        fromFile: "packages/runtime/src/index.ts",
        toFile: "packages/runtime/src/react.ts",
        specifier: "./react",
      },
    ],
  });

  assert.deepEqual(
    findings.filter((finding) => finding.kind.startsWith("root-")).map((finding) => finding.kind),
    ["root-dts-peer-type-leak", "root-subpath-peer-leak"],
  );
});

void test("effect peer range scanner reports version drift", () => {
  const findings = distributionEffectPeerFindings([
    {
      record,
      manifest: {
        peerDependencies: {
          effect: "^4.0.0-beta.84",
        },
      },
    },
    {
      record: {
        name: "@agent-os/adapter",
        path: "packages/adapter",
      },
      manifest: {
        peerDependencies: {
          effect: "^5.0.0",
        },
      },
    },
  ]);

  assert.deepEqual(
    findings.map((finding) => [finding.kind, finding.file, finding.specifier]),
    [["effect-peer-invariant", "packages/adapter/package.json", "effect"]],
  );
});

void test("distribution unit negative fixtures prove enforce gates are live", () => {
  assert.deepEqual(distributionUnitNegativeFixtureFailures(), []);
});

void test("consumer-facing docs reject obsolete package specifiers", () => {
  const findings = consumerFacingSpecifierFailuresForContent({
    file: "docs/tutorials/example.md",
    content: [
      "Use @agent-os/runtime and @yansirplus/runtime.",
      "Do not install @agent-os/agent-authoring or @yansirplus/backend-cloudflare-do.",
      "Do not document wildcard install sets like @agent-os/* or @yansirplus/*.",
      "",
    ].join("\n"),
    sourceSpecifiers: new Set(["@agent-os/runtime"]),
    publicSpecifiers: new Set(["@yansirplus/runtime"]),
    toolingSourceSpecifiers: new Set(),
  });

  assert.deepEqual(findings, [
    "docs/tutorials/example.md:2:16: obsolete consumer-facing package specifier @agent-os/agent-authoring",
    "docs/tutorials/example.md:2:45: obsolete consumer-facing package specifier @yansirplus/backend-cloudflare-do",
    "docs/tutorials/example.md:3:44: obsolete consumer-facing package specifier @agent-os/*",
    "docs/tutorials/example.md:3:59: obsolete consumer-facing package specifier @yansirplus/*",
  ]);
});

void test("docs link integrity rejects relative links to deleted docs", () => {
  const findings = markdownLinkFailuresForContent({
    file: "docs/guides/example.md",
    content:
      "Read [old package](../packages/attached-stream.md) and [external](https://example.com).\n",
  });

  assert.deepEqual(findings, [
    "docs/guides/example.md:1:6: markdown link target ../packages/attached-stream.md does not resolve to docs/packages/attached-stream.md",
  ]);
});

void test("package import DAG constraints reject stale package names", () => {
  const findings = packageConstraintNameFailures({
    ruleId: "substrate-import-dag",
    records: [{ name: "@agent-os/core", path: "packages/core" }],
    constraints: {
      forbiddenEdges: [
        {
          fromPackageNames: ["@agent-os/runtime-protocol"],
          allowedTargetPackageNames: ["@agent-os/backend-protocol"],
        },
      ],
    },
  });

  assert.deepEqual(findings, [
    "substrate-import-dag: constraints.forbiddenEdges[0].fromPackageNames references non-workspace package @agent-os/runtime-protocol",
    "substrate-import-dag: constraints.forbiddenEdges[0].allowedTargetPackageNames references non-workspace package @agent-os/backend-protocol",
  ]);
});
