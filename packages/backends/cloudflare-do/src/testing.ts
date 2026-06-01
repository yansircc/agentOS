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

type AgentDOTestingDrainBase<
  Env extends CloudflareAgentEnv,
  Runtime extends AgentRuntimeReaderClient,
> = new (...args: any[]) => AgentDurableObject<Env, Runtime>;

export const withAgentDOTestingDrain = <
  Env extends CloudflareAgentEnv,
  Runtime extends AgentRuntimeReaderClient,
  Base extends AgentDOTestingDrainBase<Env, Runtime>,
>(
  Base: Base,
): new (ctx: DurableObjectState, env: Env) => InstanceType<Base> & AgentDOTestingDrainRuntime => {
  class AgentDOWithTestingDrain extends Base implements AgentDOTestingDrainRuntime {
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
    env: Env,
  ) => InstanceType<Base> & AgentDOTestingDrainRuntime;
};
