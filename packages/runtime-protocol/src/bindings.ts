import type { LlmRoute } from "@agent-os/llm-protocol";
import type { MaterialRef } from "@agent-os/kernel/material-ref";
import type { ResolvedMaterial } from "@agent-os/kernel/ref-resolver";
import type { ExecutionDomainDeclaration, Tool } from "@agent-os/kernel/tools";
import type { AnyAgentCapabilityDefinition } from "./capability";
import type { HandlerKind } from "./manifest";
import type { AgentIntent } from "./intent";
import type { SubmitDecisionInterrupt, SubmitToolContext, SubmitToolIntent } from "./submit";

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
  readonly executionDomains?: ReadonlyArray<ExecutionDomainDeclaration>;
  readonly capabilities?: Readonly<Record<string, AnyAgentCapabilityDefinition>>;
  readonly materials?: Readonly<Record<string, MaterialRef>>;
}

export interface AgentSubmitBindings {
  readonly llmRoutes?: Readonly<Record<string, LlmRoute>>;
  readonly tools?: Readonly<Record<string, Tool>>;
  readonly executionDomains?: ReadonlyArray<ExecutionDomainDeclaration>;
  readonly materials?: Readonly<Record<string, MaterialRef>>;
  readonly resolvedMaterials?: Readonly<Record<string, ResolvedMaterial>>;
  readonly toolContext?: SubmitToolContext;
  readonly toolIntents?: ReadonlyArray<SubmitToolIntent>;
  readonly context?: Record<string, unknown>;
  readonly decisionInterrupts?: ReadonlyArray<SubmitDecisionInterrupt>;
}

export const defineAgentBindings = <K extends HandlerKind>(
  bindings: AgentBindings<K>,
): AgentBindings<K> => bindings;

export const defineAgentSubmitBindings = (bindings: AgentSubmitBindings): AgentSubmitBindings =>
  bindings;
