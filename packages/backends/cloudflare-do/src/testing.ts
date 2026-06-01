import {
  AgentDurableObject,
  type AgentDrainDueTestingOptions,
  type AgentDrainUntilQuietTestingOptions,
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

type AgentDOTestingDrainBase = new (...args: any[]) => AgentDurableObject<any, any>;

type AgentDOTestingDrainEnv<Base extends AgentDOTestingDrainBase> = Base extends new (
  ctx: DurableObjectState,
  env: infer Env,
) => AgentDurableObject<any, any>
  ? Env extends CloudflareAgentEnv
    ? Env
    : CloudflareAgentEnv
  : CloudflareAgentEnv;

export const withAgentDOTestingDrain = <Base extends AgentDOTestingDrainBase>(
  Base: Base,
): new (
  ctx: DurableObjectState,
  env: AgentDOTestingDrainEnv<Base>,
) => InstanceType<Base> & AgentDOTestingDrainRuntime => {
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
    env: AgentDOTestingDrainEnv<Base>,
  ) => InstanceType<Base> & AgentDOTestingDrainRuntime;
};
