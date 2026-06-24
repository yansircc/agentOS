/**
 * Capability contract definition - single source of truth for capability facts and installation
 * @public
 */

import type { ExtensionDeclaration } from "@agent-os/core/extensions";
import type { Carrier } from "@agent-os/core/carrier";
import type { AgentSubmitBindings } from "@agent-os/core/runtime-protocol";
import type { AnyMaterializedProjectionDefinition } from "../projection";
import type { AnyDurableTrigger } from "../trigger";
import type { EventHandler } from "@agent-os/core/types";
import type { CapabilityRequirements } from "./requirements";
import type { RuntimeDiagnosticApi } from "./diagnostics";
import type { InstalledCapabilityHandle } from "./install-context";
import type { ResolvedHostFacts } from "./host";

/**
 * Result of a capability installation
 */
export interface CapabilityInstallation {
  readonly extensions?: ReadonlyArray<ExtensionDeclaration>;
  readonly declaredIntents?: ReadonlyArray<{
    readonly kind: string;
    readonly boundaryOwnerId: string;
  }>;
  readonly projections?: ReadonlyArray<AnyMaterializedProjectionDefinition>;
  readonly triggers?: ReadonlyArray<AnyDurableTrigger>;
  readonly eventHandlers?: (ctx: CapabilityInstallContext) => ReadonlyArray<{
    readonly kind: string;
    readonly handler: EventHandler;
  }>;
  readonly bindings?: AgentSubmitBindings;
}

/**
 * Context provided to capability install functions
 */
export interface CapabilityInstallContext {
  readonly capabilities: ReadonlyMap<string, InstalledCapabilityHandle>;
  readonly host: ResolvedHostFacts;
  readonly config: Readonly<Record<string, unknown>>;
  readonly secrets: Readonly<Record<string, string>>;
  readonly diagnostics: RuntimeDiagnosticApi;
  readonly identity: string;
}

/**
 * Define capability spec
 */
export interface DefineCapabilitySpec {
  readonly capabilityId: string;
  readonly carrier: Carrier<any, any>;
  readonly requires?: CapabilityRequirements;
  readonly install: (
    ctx: CapabilityInstallContext,
  ) => CapabilityInstallation | Promise<CapabilityInstallation>;
  readonly diagnostics?: () => ReadonlyArray<{
    readonly capabilityId?: string;
    readonly reason: string;
    readonly detail?: unknown;
  }>;
}

/**
 * Capability contract interface
 */
export interface CapabilityContract {
  readonly capabilityId: string;
  readonly sourcePackageName: string;
  readonly carrier: Carrier<any, any>;
  readonly requires: CapabilityRequirements;
  readonly install: (
    ctx: CapabilityInstallContext,
  ) => CapabilityInstallation | Promise<CapabilityInstallation>;
  readonly diagnostics: () => ReadonlyArray<{
    readonly capabilityId?: string;
    readonly reason: string;
    readonly detail?: unknown;
  }>;
}

/**
 * Define a new capability contract
 *
 * @agentosPrimitive primitive.runtime.defineCapability
 * @agentosInvariant invariant.capability.single-generator
 * @agentosDocs docs/advanced/capability-authoring/define-capability.md
 * @agentosTest packages/runtime/test/capability/capability-contract.test.ts
 * @public
 */
export const defineCapability = (spec: DefineCapabilitySpec): CapabilityContract => {
  if (spec.capabilityId !== spec.carrier.ownerId) {
    throw new TypeError( // eff-ignore EFF025 reason="defineCapability is a synchronous contract factory and must fail before exposing an invalid CapabilityContract"
      `defineCapability: capabilityId "${spec.capabilityId}" does not match carrier.ownerId "${spec.carrier.ownerId}"`,
    );
  }

  return {
    capabilityId: spec.capabilityId,
    sourcePackageName: spec.carrier.sourcePackageName,
    carrier: spec.carrier,
    requires: spec.requires ?? {},
    install: spec.install,
    diagnostics: spec.diagnostics ?? (() => []),
  };
};
