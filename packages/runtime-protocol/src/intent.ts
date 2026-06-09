import type { AuthorityRef, ScopeRef } from "@agent-os/kernel/effect-claim";
import { RUNTIME_EVENT_KIND } from "./runtime-events";

export const AGENT_INTENT_EVENT_KINDS = [
  "agent.intent.submitted",
  "agent.intent.resumed",
  "agent.intent.cancel_requested",
] as const;

export type AgentIntentKind = (typeof AGENT_INTENT_EVENT_KINDS)[number];

export const AGENT_SETTLEMENT_EVENT_KINDS = [
  RUNTIME_EVENT_KIND.AGENT_RUN_STARTED,
  RUNTIME_EVENT_KIND.CHAT_INGESTED,
  RUNTIME_EVENT_KIND.LLM_RESPONSE,
  RUNTIME_EVENT_KIND.TOOL_EXECUTED,
  RUNTIME_EVENT_KIND.TOOL_REJECTED,
  RUNTIME_EVENT_KIND.AGENT_RUN_INTERRUPTED,
  RUNTIME_EVENT_KIND.AGENT_RUN_RESUMED,
  RUNTIME_EVENT_KIND.AGENT_RUN_COMPLETED,
  ...Object.values(RUNTIME_EVENT_KIND).filter((kind) => kind.startsWith("agent.aborted.")),
] as const;

export type AgentSettlementKind = (typeof AGENT_SETTLEMENT_EVENT_KINDS)[number];

export interface AgentIntent<K extends AgentIntentKind = AgentIntentKind, P = unknown> {
  readonly kind: K;
  readonly payload: P;
  readonly intentRef: string;
  readonly scopeRef: ScopeRef;
  readonly effectAuthorityRef: AuthorityRef;
}

export type IntentSettlementVocabularyIssue =
  | {
      readonly kind: "overlap";
      readonly eventKind: string;
    }
  | {
      readonly kind: "generic_mutation";
      readonly eventKind: string;
    };

const genericMutationKinds = new Set([
  ["mutation", "proposed"].join("."),
  ["mutation", "settled"].join("."),
  ["state", "transitioned"].join("."),
  ["entity", "updated"].join("."),
]);

export const validateIntentSettlementVocabulary = (
  intents: ReadonlyArray<string> = AGENT_INTENT_EVENT_KINDS,
  settlements: ReadonlyArray<string> = AGENT_SETTLEMENT_EVENT_KINDS,
): ReadonlyArray<IntentSettlementVocabularyIssue> => {
  const issues: IntentSettlementVocabularyIssue[] = [];
  const settlementSet = new Set(settlements);
  for (const intent of intents) {
    if (settlementSet.has(intent)) {
      issues.push({ kind: "overlap", eventKind: intent });
    }
    if (genericMutationKinds.has(intent)) {
      issues.push({ kind: "generic_mutation", eventKind: intent });
    }
  }
  for (const settlement of settlements) {
    if (genericMutationKinds.has(settlement)) {
      issues.push({ kind: "generic_mutation", eventKind: settlement });
    }
  }
  return issues;
};
