import type {
  RuntimeLedgerEvent,
  SubmitResult,
  SubmitRunInput,
} from "@agent-os/core/runtime-protocol";
import {
  createAgentClient,
  type AgentClientCommandMap,
  type AgentClientController,
  type AgentClientRpcInvoker,
  type AgentClientStreamSource,
} from "./index";

export type ProductShellCommandMap = AgentClientCommandMap;

export interface AgentPromptOptions extends Omit<SubmitRunInput, "intent" | "context"> {
  readonly context?: SubmitRunInput["context"];
}

export interface AgentSession {
  readonly sessionRef: string;
  readonly prompt: (text: string, options?: AgentPromptOptions) => Promise<SubmitResult>;
}

export interface AgentSessionTurnInput extends SubmitRunInput {
  readonly sessionRef: string;
  readonly turnRef: string;
}

export interface AgentSessionCorrelation {
  readonly createSessionRef?: () => string;
  readonly createTurnRef?: (input: {
    readonly sessionRef: string;
    readonly turnIndex: number;
  }) => string;
}

export interface CreateAgentSessionOptions {
  readonly submitTurn: (input: AgentSessionTurnInput) => Promise<SubmitResult>;
  readonly correlation?: AgentSessionCorrelation;
}

const randomCorrelationRef = (): string => crypto.randomUUID();

export const createAgentSession = (options: CreateAgentSessionOptions): AgentSession => {
  const sessionRef = (options.correlation?.createSessionRef ?? randomCorrelationRef)();
  const createTurnRef = options.correlation?.createTurnRef ?? randomCorrelationRef;
  let turnIndex = 0;

  return {
    sessionRef,
    prompt(text, promptOptions = {}) {
      turnIndex += 1;
      const turnRef = createTurnRef({ sessionRef, turnIndex });
      const { context = {}, ...input } = promptOptions;
      return options.submitTurn({
        ...input,
        sessionRef,
        turnRef,
        intent: text,
        context,
      });
    },
  };
};

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
