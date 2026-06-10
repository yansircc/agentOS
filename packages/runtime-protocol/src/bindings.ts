import type { LlmRoute } from "@agent-os/llm-protocol";
import type { MaterialRef } from "@agent-os/kernel/material-ref";
import type { Tool } from "@agent-os/kernel/tools";
import type { HandlerKind } from "./manifest";
import type { AgentIntent } from "./intent";

export interface AgentHandlerContext {
  readonly intent: AgentIntent;
  readonly runId?: number;
}

export type AgentHandlerResult = unknown;

export type AgentHandler = (ctx: AgentHandlerContext) => AgentHandlerResult;

export type AgentHandlerBindings<K extends HandlerKind> = Readonly<
  Record<K, AgentHandler> & Partial<Record<HandlerKind, AgentHandler>>
>;

export interface AgentBindings<K extends HandlerKind = HandlerKind> {
  readonly handlers: AgentHandlerBindings<K>;
  readonly llmRoutes?: Readonly<Record<string, LlmRoute>>;
  readonly tools?: Readonly<Record<string, Tool>>;
  readonly materials?: Readonly<Record<string, MaterialRef>>;
}

export type AgentSubmitBindings = AgentBindings<never>;

export const defineAgentBindings = <K extends HandlerKind>(
  bindings: AgentBindings<K>,
): AgentBindings<K> => bindings;

export const defineAgentSubmitBindings = (bindings: AgentSubmitBindings): AgentSubmitBindings =>
  bindings;
