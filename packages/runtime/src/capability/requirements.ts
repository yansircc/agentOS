/**
 * Capability requirement declarations used by CapabilityContract preflight.
 * @public
 */

import type { AgentSchemaDecoder } from "@agent-os/core/agent-schema";

/**
 * Fact provided by a host profile that capabilities can require
 */
export type HostProvidedFact =
  | "storage.ledger"
  | "fs.workspace"
  | "timer.durable"
  | "durability.do"
  | "network.outbound"
  | "secrets.store"
  | "eventLoop.durable"
  | "llm.anthropic"
  | "llm.openai";

/**
 * Requirement for host-provided facts
 */
export interface CapabilityHostFactRequirement {
  readonly fact: HostProvidedFact;
  readonly optional?: boolean;
}

/**
 * Requirement for another capability (peer dependency)
 */
export interface CapabilityPeerRequirement {
  readonly capabilityId: string;
  readonly version?: string;
  readonly optional?: boolean;
}

/**
 * Requirement for a configuration value with schema validation
 */
export interface CapabilityConfigRequirement<T = unknown> {
  readonly key: string;
  readonly schema: AgentSchemaDecoder<T>;
  readonly optional?: boolean;
  readonly default?: T;
}

/**
 * Requirement for a secret value
 */
export interface CapabilitySecretRequirement {
  readonly key: string;
  readonly optional?: boolean;
}

/**
 * All capability requirements
 */
export interface CapabilityRequirements {
  readonly hostFacts?: ReadonlyArray<HostProvidedFact | CapabilityHostFactRequirement>;
  readonly peers?: ReadonlyArray<string | CapabilityPeerRequirement>;
  readonly config?: ReadonlyArray<CapabilityConfigRequirement>;
  readonly secrets?: ReadonlyArray<string | CapabilitySecretRequirement>;
}

/**
 * Consumer-facing capability requirement declaration.
 */
export type CapabilityRequirement =
  | string
  | {
      readonly name: string;
      readonly version?: string;
      readonly config?: Readonly<Record<string, unknown>>;
    };
