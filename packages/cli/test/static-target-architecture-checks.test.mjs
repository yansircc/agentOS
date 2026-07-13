import assert from "node:assert/strict";
import test from "node:test";
import { staticTargetArchitectureFailures } from "../src/check/algorithmic/static-target-checks.mjs";

const manifestCompilerSource = `
export interface ProductPlan {
  readonly agent: unknown;
  readonly instructions: unknown;
  readonly symbolicRequirements: readonly unknown[];
  readonly assets: unknown;
  readonly provenance: unknown;
  readonly productDigest: string;
}
export type CompileProductPlanResult = { readonly ok: true; readonly value: ProductPlan };
export const compileProductPlan = (_tree: unknown): CompileProductPlanResult => ({
  ok: true,
  value: {} as ProductPlan,
});
`;

const deploymentIntentSource = `
export interface LocalHost { readonly kind: "local" }
export interface DeploymentIntent { readonly kind: "deployment" }
export type StaticTargetBinding = LocalHost | DeploymentIntent;
`;

const authoringRoot = "packages/cli/src/build/agent-authoring";
const manifestCompilerPath = `${authoringRoot}/manifest-compiler.ts`;
const deploymentIntentPath = `${authoringRoot}/deployment-intent.ts`;
const sharedPath = `${authoringRoot}/shared.ts`;
const facadePath = `${authoringRoot}/static-target.ts`;
const staticTargetRoot = `${authoringRoot}/static-target`;
const paths = {
  artifacts: `${staticTargetRoot}/artifacts.ts`,
  compiler: `${staticTargetRoot}/compiler.ts`,
  encoding: `${staticTargetRoot}/encoding.ts`,
  linker: `${staticTargetRoot}/linker.ts`,
  model: `${staticTargetRoot}/model.ts`,
  registries: `${staticTargetRoot}/registries.ts`,
  semanticBootstrap: `${staticTargetRoot}/semantic-bootstrap.ts`,
  rendererHelper: `${staticTargetRoot}/renderer-helper.ts`,
  clientBrowser: `${staticTargetRoot}/renderers/client-browser.ts`,
  clientRemoteChat: `${staticTargetRoot}/renderers/client-remote-chat.ts`,
  clientRemoteWorkspace: `${staticTargetRoot}/renderers/client-remote-workspace.ts`,
  hostCloudflare: `${staticTargetRoot}/renderers/host-cloudflare.ts`,
  hostLocal: `${staticTargetRoot}/renderers/host-local.ts`,
  profileChat: `${staticTargetRoot}/renderers/profile-chat.ts`,
  profileWorkspace: `${staticTargetRoot}/renderers/profile-workspace.ts`,
};

const rendererPaths = [
  paths.clientBrowser,
  paths.clientRemoteChat,
  paths.clientRemoteWorkspace,
  paths.hostCloudflare,
  paths.hostLocal,
  paths.profileChat,
  paths.profileWorkspace,
];

const facadeSource = `
export { bindStaticTargetPlan, linkStaticTarget } from "./static-target/compiler";
export { renderStaticTargetPlan } from "./static-target/artifacts";
export type {
  StaticTargetLink,
  StaticTargetLinkResult,
  StaticTargetPlan,
  StaticTargetPlanResult,
} from "./static-target/model";
`;

const modelSource = `
export interface StaticRuntimeBootstrapModel {
  readonly toolNames: readonly string[];
}
export interface StaticTargetRenderInput {
  readonly bootstrap: StaticRuntimeBootstrapModel;
  readonly deploymentId: string;
}
export interface StaticTargetWorkspaceRenderInput extends StaticTargetRenderInput {
  readonly workspaceRoot: string;
}
export interface StaticTargetModules {
  readonly runtime: string;
}
export interface StaticTargetPlanShared {
  readonly toolNames: readonly string[];
}
export interface StaticTargetProfileProjection {
  readonly kind: "workspace" | "chat";
  readonly renderInput: StaticTargetRenderInput;
  readonly canonicalDeployment: unknown;
  readonly mount: unknown;
}
export interface StaticTargetHostProjection {
  readonly kind: "node@1" | "cloudflare-do@1";
  readonly target: unknown;
  readonly canonicalDeployment: unknown;
  readonly mount: unknown;
}
export interface StaticTargetClientProjection {
  readonly kind: "direct" | "svelte-kit-remote";
}
export interface StaticTargetPlan {
  readonly shared: StaticTargetPlanShared;
  readonly profile: StaticTargetProfileProjection;
  readonly host: StaticTargetHostProjection;
  readonly client: StaticTargetClientProjection;
}
export type StaticTargetPlanResult =
  | { readonly ok: true; readonly value: StaticTargetPlan }
  | { readonly ok: false; readonly issues: readonly unknown[] };
export interface StaticTargetLink {
  readonly files: readonly unknown[];
  readonly moduleGraph: readonly unknown[];
  readonly canonicalDeployment: unknown;
  readonly mount: unknown;
}
export type StaticTargetLinkResult =
  | { readonly ok: true; readonly value: StaticTargetLink }
  | { readonly ok: false; readonly issues: readonly unknown[] };
`;

const encodingSource = `
import type { StaticTargetModules } from "./model";
export const jsString = (value: string): string => JSON.stringify(value);
export const staticTargetModules = (): StaticTargetModules => ({ runtime: "runtime" });
`;

const registriesSource = `
import type { StaticTargetRenderInput } from "./model";
import { jsString } from "./encoding";
export const renderRegistries = (input: StaticTargetRenderInput): string =>
  jsString(input.deploymentId);
`;

const semanticBootstrapSource = `
import type { StaticRuntimeBootstrapModel } from "./model";
import { jsString } from "./encoding";
import { renderRegistries } from "./registries";
export const renderStaticRuntimeBootstrap = (model: StaticRuntimeBootstrapModel): string =>
  jsString(model.toolNames.join(","));
void renderRegistries;
`;

const profileWorkspaceSource = `
import type { StaticTargetModules, StaticTargetWorkspaceRenderInput } from "../model";
import { jsString } from "../encoding";
import { renderStaticRuntimeBootstrap } from "../semantic-bootstrap";
export const renderWorkspaceStaticTarget = (
  input: StaticTargetWorkspaceRenderInput,
  modules: StaticTargetModules,
): string => jsString(input.workspaceRoot + modules.runtime) +
  renderStaticRuntimeBootstrap(input.bootstrap);
`;

const profileChatSource = `
import type { StaticTargetModules, StaticTargetRenderInput } from "../model";
import { jsString } from "../encoding";
import { renderStaticRuntimeBootstrap } from "../semantic-bootstrap";
export const renderChatStaticTarget = (
  input: StaticTargetRenderInput,
  modules: StaticTargetModules,
): string => jsString(input.deploymentId + modules.runtime) +
  renderStaticRuntimeBootstrap(input.bootstrap);
`;

const hostLocalSource = `
import type { StaticTargetModules, StaticTargetRenderInput } from "../model";
import { jsString } from "../encoding";
import { renderStaticRuntimeBootstrap } from "../semantic-bootstrap";
export const renderLocalAgentApp = (
  input: StaticTargetRenderInput,
  modules: StaticTargetModules,
): string => jsString(input.deploymentId + modules.runtime) +
  renderStaticRuntimeBootstrap(input.bootstrap);
`;

const hostCloudflareSource = `
import type { StaticTargetModules, StaticTargetRenderInput } from "../model";
import { jsString } from "../encoding";
export const renderCloudflareWorkerEntry = (
  input: StaticTargetRenderInput,
  modules: StaticTargetModules,
): string => jsString(input.deploymentId + modules.runtime);
`;

const clientBrowserSource = `
import type { StaticTargetModules } from "../model";
import { jsString } from "../encoding";
export const renderBrowserClient = (modules: StaticTargetModules): string =>
  jsString(modules.runtime);
`;

const clientRemoteWorkspaceSource = `
import type { StaticTargetModules } from "../model";
import { jsString } from "../encoding";
export const renderWorkspaceRemoteClient = (modules: StaticTargetModules): string =>
  jsString(modules.runtime);
`;

const clientRemoteChatSource = `
import type { StaticTargetModules } from "../model";
import { jsString } from "../encoding";
export const renderChatRemoteClient = (modules: StaticTargetModules): string =>
  jsString(modules.runtime);
`;

const artifactsSource = `
import type { StaticTargetLink, StaticTargetPlan } from "./model";
import { renderBrowserClient } from "./renderers/client-browser";
import { renderChatRemoteClient } from "./renderers/client-remote-chat";
import { renderWorkspaceRemoteClient } from "./renderers/client-remote-workspace";
import { renderCloudflareWorkerEntry } from "./renderers/host-cloudflare";
import { renderLocalAgentApp } from "./renderers/host-local";
import { renderChatStaticTarget } from "./renderers/profile-chat";
import { renderWorkspaceStaticTarget } from "./renderers/profile-workspace";
export const renderStaticTargetPlan = (plan: StaticTargetPlan): StaticTargetLink => ({
  files: [],
  moduleGraph: [],
  canonicalDeployment: {
    ...plan.profile.canonicalDeployment,
    ...plan.host.canonicalDeployment,
    client: plan.client.kind,
    toolNames: plan.shared.toolNames,
  },
  mount: { ...plan.host.mount, ...plan.profile.mount },
});
void [
  renderBrowserClient,
  renderChatRemoteClient,
  renderWorkspaceRemoteClient,
  renderCloudflareWorkerEntry,
  renderLocalAgentApp,
  renderChatStaticTarget,
  renderWorkspaceStaticTarget,
];
`;

const linkerSource = `
import type { StaticTargetLinkResult, StaticTargetPlanResult } from "./model";
import { renderStaticTargetPlan } from "./artifacts";
export const linkStaticTargetPlan = (planned: StaticTargetPlanResult): StaticTargetLinkResult =>
  planned.ok ? { ok: true, value: renderStaticTargetPlan(planned.value) } : planned;
`;

const compilerSource = `
import type { ProductPlan } from "../manifest-compiler";
import type { StaticTargetBinding } from "../deployment-intent";
import type {
  StaticTargetLinkResult,
  StaticTargetPlan,
  StaticTargetPlanResult,
} from "./model";
import { linkStaticTargetPlan } from "./linker";
const bindingFactsFor = (_product: ProductPlan, _binding: StaticTargetBinding) => ({
  ok: true as const,
  value: {},
});
const staticTargetPlanFor = (
  _product: ProductPlan,
  _facts: unknown,
  _modules: unknown,
): StaticTargetPlanResult => ({ ok: false, issues: [] });
export const bindStaticTargetPlan = (
  product: ProductPlan,
  binding: StaticTargetBinding,
): StaticTargetPlanResult => {
  const facts = bindingFactsFor(product, binding);
  return staticTargetPlanFor(product, facts.value, {});
};
export const linkStaticTarget = (
  product: ProductPlan,
  binding: StaticTargetBinding,
): StaticTargetLinkResult => linkStaticTargetPlan(bindStaticTargetPlan(product, binding));
void (undefined as StaticTargetPlan | undefined);
`;

const sharedSource = `
export const isWorkspaceToolName = (name: string): boolean => name.startsWith("workspace.");
`;

const legalModuleSources = {
  [manifestCompilerPath]: manifestCompilerSource,
  [deploymentIntentPath]: deploymentIntentSource,
  [sharedPath]: sharedSource,
  [facadePath]: facadeSource,
  [paths.artifacts]: artifactsSource,
  [paths.compiler]: compilerSource,
  [paths.encoding]: encodingSource,
  [paths.linker]: linkerSource,
  [paths.model]: modelSource,
  [paths.registries]: registriesSource,
  [paths.semanticBootstrap]: semanticBootstrapSource,
  [paths.clientBrowser]: clientBrowserSource,
  [paths.clientRemoteChat]: clientRemoteChatSource,
  [paths.clientRemoteWorkspace]: clientRemoteWorkspaceSource,
  [paths.hostCloudflare]: hostCloudflareSource,
  [paths.hostLocal]: hostLocalSource,
  [paths.profileChat]: profileChatSource,
  [paths.profileWorkspace]: profileWorkspaceSource,
};

const failuresFor = ({ moduleOverrides = {}, ...overrides } = {}) => {
  const staticTargetModuleSources = { ...legalModuleSources, ...moduleOverrides };
  return staticTargetArchitectureFailures({
    manifestCompilerSource,
    deploymentIntentSource,
    staticTargetSource: staticTargetModuleSources[facadePath],
    staticTargetModuleSources,
    entrySources: [{ path: "packages/cli/src/index.ts", source: "export {};" }],
    legacyConfigPresent: false,
    ...overrides,
  });
};

const assertFailureIncludes = (failures, ...markers) => {
  assert.ok(
    failures.some((failure) => markers.every((marker) => failure.includes(marker))),
    `expected failure containing ${markers.join(" + ")}, observed:\n${failures.join("\n")}`,
  );
};

void test("accepts the legal physical static-target module graph", () => {
  assert.deepEqual(failuresFor(), []);
});

void test("rejects host facts in ProductPlan", () => {
  const failures = failuresFor({
    manifestCompilerSource: manifestCompilerSource.replace(
      "readonly productDigest: string;",
      "readonly productDigest: string; readonly deployment: unknown;",
    ),
  });
  assert.ok(failures.some((failure) => failure.includes("leaks binding field deployment")));
});

void test("rejects a binder that does not consume ProductPlan plus StaticTargetBinding", () => {
  const failures = failuresFor({
    moduleOverrides: {
      [paths.compiler]: compilerSource.replace(
        "binding: StaticTargetBinding,\n): StaticTargetPlanResult",
        "binding: DeploymentIntent,\n): StaticTargetPlanResult",
      ),
    },
  });
  assertFailureIncludes(failures, "must consume ProductPlan + StaticTargetBinding");
});

void test("rejects a renderer that directly imports the authoring compiler", () => {
  const failures = failuresFor({
    moduleOverrides: {
      [paths.profileWorkspace]: `${profileWorkspaceSource}
import type { ProductPlan } from "../../manifest-compiler";
void (undefined as ProductPlan | undefined);
`,
    },
  });
  assertFailureIncludes(failures, "renderer dependency reaches authoring compiler");
});

void test("rejects renderer to helper to compiler dependency leakage", () => {
  const failures = failuresFor({
    moduleOverrides: {
      [paths.profileWorkspace]: `${profileWorkspaceSource}
import { rendererHelper } from "../renderer-helper";
void rendererHelper;
`,
      [paths.rendererHelper]: `
import type { ProductPlan } from "../manifest-compiler";
export const rendererHelper = (plan: ProductPlan): ProductPlan => plan;
`,
    },
  });
  assertFailureIncludes(failures, "renderer dependency reaches authoring compiler");
});

void test("rejects type-only re-export leakage through renderer support", () => {
  const failures = failuresFor({
    moduleOverrides: {
      [paths.semanticBootstrap]: `${semanticBootstrapSource}
export type { ProductPlan } from "../manifest-compiler";
`,
    },
  });
  assertFailureIncludes(failures, "renderer dependency reaches authoring compiler");
});

void test("rejects renderer-owned workspace classification", () => {
  const failures = failuresFor({
    moduleOverrides: {
      [paths.profileWorkspace]: `${profileWorkspaceSource}
import { isWorkspaceToolName } from "../../shared";
void isWorkspaceToolName("workspace.read");
`,
    },
  });
  assertFailureIncludes(failures, "renderer performs second compilation");
});

void test("rejects a renderer that consumes the whole StaticTargetPlan", () => {
  const failures = failuresFor({
    moduleOverrides: {
      [paths.profileChat]: `
import type { StaticTargetPlan } from "../model";
export const renderChatStaticTarget = (plan: StaticTargetPlan): string =>
  String(plan.profile.kind);
`,
    },
  });
  assertFailureIncludes(failures, "renderer performs second compilation");
});

void test("rejects a renderer that rebranches across profile and client axes", () => {
  const failures = failuresFor({
    moduleOverrides: {
      [paths.profileChat]: `
import type { StaticTargetPlan } from "../model";
export const renderChatStaticTarget = (plan: StaticTargetPlan): string =>
  plan.profile.kind === "chat" && plan.client.kind === "direct" ? "chat" : "other";
`,
    },
  });
  assertFailureIncludes(failures, "renderer performs second compilation");
});

void test("rejects raw product and deployment input ownership in the closed linker", () => {
  const failures = failuresFor({
    moduleOverrides: {
      [paths.linker]: `
import type { ProductPlan } from "../manifest-compiler";
import type { StaticTargetBinding } from "../deployment-intent";
import type { StaticTargetLinkResult } from "./model";
export const linkStaticTargetPlan = (
  _product: ProductPlan,
  _binding: StaticTargetBinding,
): StaticTargetLinkResult => ({ ok: false, issues: [] });
`,
    },
  });
  assertFailureIncludes(failures, "linker must not consume raw input");
});

void test("rejects wildcard ownership in the static-target facade", () => {
  const failures = failuresFor({
    moduleOverrides: {
      [facadePath]: `export * from "./static-target/compiler";`,
    },
  });
  assertFailureIncludes(failures, "facade must not use export *");
});

for (const field of ["files", "moduleGraph", "clientCandidates"]) {
  void test(`rejects pre-rendered ${field} in the closed plan model`, () => {
    const failures = failuresFor({
      moduleOverrides: {
        [paths.model]: modelSource.replace(
          "readonly client: StaticTargetClientProjection;",
          `readonly client: StaticTargetClientProjection; readonly ${field}: unknown;`,
        ),
      },
    });
    assertFailureIncludes(failures, `plan model contains pre-rendered field ${field}`);
  });
}

void test("rejects non-literal dynamic imports in the static-target module graph", () => {
  const failures = failuresFor({
    moduleOverrides: {
      [paths.profileWorkspace]: `${profileWorkspaceSource}
const compilerModule = "../compiler";
void import(compilerModule);
`,
    },
  });
  assertFailureIncludes(failures, "static target module graph contains non-literal dynamic import");
});

void test("rejects require in the static-target module graph", () => {
  const failures = failuresFor({
    moduleOverrides: {
      [paths.profileWorkspace]: `${profileWorkspaceSource}
const compilerModule = "../compiler";
void require(compilerModule);
`,
    },
  });
  assertFailureIncludes(failures, "static target module graph forbids require");
});

void test("rejects triple-slash references in the static-target module graph", () => {
  const failures = failuresFor({
    moduleOverrides: {
      [paths.profileWorkspace]: `/// <reference path="../compiler.ts" />
${profileWorkspaceSource}`,
    },
  });
  assertFailureIncludes(failures, "static target module graph forbids triple-slash path reference");
});

void test("keeps the renderer root inventory aligned with the physical split", () => {
  assert.deepEqual(
    rendererPaths,
    Object.keys(legalModuleSources)
      .filter((path) => path.includes("/renderers/"))
      .sort(),
  );
});

void test("rejects every legacy authoring entry", () => {
  const entryFailure = failuresFor({
    entrySources: [
      { path: "packages/cli/src/index.ts", source: "export { compileAgentTree } from './legacy';" },
    ],
  });
  assert.ok(entryFailure.some((failure) => failure.includes("compileAgentTree")));
  assert.ok(
    failuresFor({ legacyConfigPresent: true }).some((failure) =>
      failure.includes("legacy authoring grammar must be deleted"),
    ),
  );
});
