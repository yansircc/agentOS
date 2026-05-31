import {
  AgentDurableObject,
  type AgentDrainDueTestingOptions,
  type AgentDrainUntilQuietTestingOptions,
  type AgentRuntimeReaderClient,
  type CloudflareAgentEnv,
} from "./agent-do";
import type { TriggerDrainResult, TriggerDrainUntilQuietResult } from "@agent-os/runtime";

export type { AgentDrainDueTestingOptions, AgentDrainUntilQuietTestingOptions } from "./agent-do";

export interface AgentDOTestingDrainRuntime {
  readonly __drainDueOnceForTesting: (
    options?: AgentDrainDueTestingOptions,
  ) => Promise<TriggerDrainResult>;
  readonly __drainUntilQuietForTesting: (
    options?: AgentDrainUntilQuietTestingOptions,
  ) => Promise<TriggerDrainUntilQuietResult>;
}

type AnyAgentDOClass = new (
  ctx: DurableObjectState,
  env: CloudflareAgentEnv,
) => AgentDurableObject<CloudflareAgentEnv, AgentRuntimeReaderClient>;

export const withAgentDOTestingDrain = <
  Base extends new (ctx: DurableObjectState, env: any) => object,
>(
  Base: Base,
): new (
  ctx: DurableObjectState,
  env: ConstructorParameters<Base>[1],
) => InstanceType<Base> & AgentDOTestingDrainRuntime => {
  const AgentDOBase = Base as unknown as AnyAgentDOClass;
  class AgentDOWithTestingDrain extends AgentDOBase implements AgentDOTestingDrainRuntime {
    __drainDueOnceForTesting(options?: AgentDrainDueTestingOptions): Promise<TriggerDrainResult> {
      return this.drainDueOnceForTestingFull(options);
    }

    __drainUntilQuietForTesting(
      options?: AgentDrainUntilQuietTestingOptions,
    ): Promise<TriggerDrainUntilQuietResult> {
      return this.drainUntilQuietForTestingFull(options);
    }
  }
  return AgentDOWithTestingDrain as unknown as new (
    ctx: DurableObjectState,
    env: ConstructorParameters<Base>[1],
  ) => InstanceType<Base> & AgentDOTestingDrainRuntime;
};
