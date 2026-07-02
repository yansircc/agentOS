import type { RuntimeLedgerEvent } from "@agent-os/core/runtime-protocol";
import {
  createAgentClient,
  type AgentClientCommandMap,
  type AgentClientController,
  type AgentClientRpcInvoker,
  type AgentClientStreamSource,
} from "./index";

export type ProductShellCommandMap = AgentClientCommandMap;

export type ProductShellCommandInvoker<
  Commands extends AgentClientCommandMap = AgentClientCommandMap,
> = AgentClientRpcInvoker<Commands>;

export interface ProductShellRuntimeLedgerOptions {
  readonly initialEvents?: ReadonlyArray<RuntimeLedgerEvent>;
  readonly streamSource?: AgentClientStreamSource;
}

export interface ProductShellCommandOptions<
  Commands extends AgentClientCommandMap = AgentClientCommandMap,
> {
  readonly invoke: ProductShellCommandInvoker<Commands>;
}

export interface CreateProductShellAgentClientOptions<
  Commands extends AgentClientCommandMap = AgentClientCommandMap,
> {
  readonly runtimeLedger?: ProductShellRuntimeLedgerOptions;
  readonly productCommands: ProductShellCommandOptions<Commands>;
}

export const createProductShellAgentClient = <
  Commands extends AgentClientCommandMap = AgentClientCommandMap,
>(
  options: CreateProductShellAgentClientOptions<Commands>,
): AgentClientController<Commands> =>
  createAgentClient<Commands>({
    initialEvents: options.runtimeLedger?.initialEvents,
    streamSource: options.runtimeLedger?.streamSource,
    rpcInvoker: options.productCommands.invoke,
  });
