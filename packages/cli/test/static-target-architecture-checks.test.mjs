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

const staticTargetSource = `
import type { ProductPlan } from "./manifest-compiler";
import type { StaticTargetBinding } from "./deployment-intent";

export interface StaticTargetPlan {
  readonly shared: { readonly toolNames: readonly string[] };
  readonly profile: { readonly canonicalDeployment: unknown; readonly mount: unknown };
  readonly host: {
    readonly files: readonly unknown[];
    readonly moduleGraph: readonly unknown[];
    readonly canonicalDeployment: unknown;
    readonly mount: unknown;
  };
  readonly client: { readonly kind: string };
}
export type StaticTargetPlanResult =
  | { readonly ok: true; readonly value: StaticTargetPlan }
  | { readonly ok: false };
export interface StaticTargetLink {
  readonly files: readonly unknown[];
  readonly moduleGraph: readonly unknown[];
  readonly canonicalDeployment: unknown;
  readonly mount: unknown;
}
export type StaticTargetLinkResult =
  | { readonly ok: true; readonly value: StaticTargetLink }
  | { readonly ok: false };

const bindingFactsFor = (_product: ProductPlan, _binding: StaticTargetBinding) => ({
  ok: true as const,
  value: {},
});
const staticTargetPlanFor = (
  _product: ProductPlan,
  _facts: unknown,
  _modules: unknown,
): StaticTargetPlanResult => ({ ok: false });

export const bindStaticTargetPlan = (
  product: ProductPlan,
  binding: StaticTargetBinding,
): StaticTargetPlanResult => {
  const facts = bindingFactsFor(product, binding);
  return staticTargetPlanFor(product, facts.value, {});
};

export const renderStaticTargetPlan = (plan: StaticTargetPlan): StaticTargetLink => ({
  files: plan.host.files,
  moduleGraph: plan.host.moduleGraph,
  canonicalDeployment: {
    ...plan.profile.canonicalDeployment,
    ...plan.host.canonicalDeployment,
    client: plan.client.kind,
    toolNames: plan.shared.toolNames,
  },
  mount: { ...plan.host.mount, ...plan.profile.mount },
});

export const linkStaticTarget = (
  product: ProductPlan,
  binding: StaticTargetBinding,
): StaticTargetLinkResult => {
  const planned = bindStaticTargetPlan(product, binding);
  if (!planned.ok) return planned;
  return { ok: true, value: renderStaticTargetPlan(planned.value) };
};
`;

const failuresFor = (overrides = {}) =>
  staticTargetArchitectureFailures({
    manifestCompilerSource,
    deploymentIntentSource,
    staticTargetSource,
    entrySources: [{ path: "packages/cli/src/index.ts", source: "export {};" }],
    legacyConfigPresent: false,
    ...overrides,
  });

void test("accepts the ProductPlan to closed static target algebra", () => {
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
    staticTargetSource: staticTargetSource.replace(
      "binding: StaticTargetBinding,\n): StaticTargetPlanResult",
      "binding: DeploymentIntent,\n): StaticTargetPlanResult",
    ),
  });
  assert.ok(
    failures.some((failure) => failure.includes("must consume ProductPlan + StaticTargetBinding")),
  );
});

void test("rejects a renderer that reopens the binding boundary", () => {
  const failures = failuresFor({
    staticTargetSource: staticTargetSource.replace(
      "(plan: StaticTargetPlan): StaticTargetLink",
      "(plan: StaticTargetPlan, binding: StaticTargetBinding): StaticTargetLink",
    ),
  });
  assert.ok(
    failures.some((failure) => failure.includes("consume only one closed StaticTargetPlan")),
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
