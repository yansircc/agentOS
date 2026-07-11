/**
 * Host profile definition - describes capabilities provided by a runtime host
 * @public
 */

import type { HostProvidedFact } from "./requirements";
export type { HostProvidedFact } from "./requirements";

/**
 * Resolved host facts passed to capability install functions after preflight.
 */
export interface ResolvedHostFacts {
  readonly [key: string]: unknown;
}

/**
 * Host definition spec
 */
export interface DefineHostSpec {
  readonly target: string;
  readonly provides: ReadonlyArray<HostProvidedFact>;
  readonly materialize: (input: {
    readonly config: Readonly<Record<string, unknown>>;
    readonly secrets: Readonly<Record<string, string>>;
    readonly identity: string;
  }) => ResolvedHostFacts;
}

/**
 * Host profile interface
 */
export interface HostProfile {
  readonly target: string;
  readonly provides: ReadonlySet<HostProvidedFact>;
  readonly materialize: (input: {
    readonly config: Readonly<Record<string, unknown>>;
    readonly secrets: Readonly<Record<string, string>>;
    readonly identity: string;
  }) => ResolvedHostFacts;
}

/**
 * Define a new host profile
 *
 * @agentosPrimitive primitive.runtime.defineHost
 * @agentosInvariant invariant.host.fact-owner
 * @agentosDocs docs/advanced/capability-authoring/define-host.md
 * @agentosTest packages/runtime/test/capability/capability-contract.test.ts
 * @public
 */
export const defineHost = (spec: DefineHostSpec): HostProfile => ({
  target: spec.target,
  provides: new Set(spec.provides),
  materialize: spec.materialize,
});
