import { describe, expect, it } from "@effect/vitest";
import {
  AGENT_INTENT_EVENT_KINDS,
  AGENT_SETTLEMENT_EVENT_KINDS,
  RUNTIME_EVENT_KIND,
  validateIntentSettlementVocabulary,
  type AgentIntent,
} from "../../src/runtime-protocol";

const identity = {
  scopeRef: { kind: "conversation" as const, scopeId: "intent-test" },
  effectAuthorityRef: { authorityClass: "agent" as const, authorityId: "intent-test" },
};

describe("Agent intent vocabulary", () => {
  it("keeps intent and settlement event kinds disjoint", () => {
    expect(validateIntentSettlementVocabulary()).toEqual([]);
    expect(AGENT_INTENT_EVENT_KINDS).toContain("agent.intent.submitted");
    expect(AGENT_SETTLEMENT_EVENT_KINDS).toContain(RUNTIME_EVENT_KIND.AGENT_RUN_COMPLETED);
  });

  it("detects overlap between intent and settlement vocabularies", () => {
    expect(
      validateIntentSettlementVocabulary(
        ["agent.intent.submitted", RUNTIME_EVENT_KIND.AGENT_RUN_STARTED],
        [RUNTIME_EVENT_KIND.AGENT_RUN_STARTED],
      ),
    ).toEqual([{ kind: "overlap", eventKind: RUNTIME_EVENT_KIND.AGENT_RUN_STARTED }]);
  });

  it("rejects fake-generic mutation and state lifecycle names", () => {
    const stateTransitioned = ["state", "transitioned"].join(".");
    const entityUpdated = ["entity", "updated"].join(".");
    expect(validateIntentSettlementVocabulary([stateTransitioned], [])).toEqual([
      { kind: "generic_mutation", eventKind: stateTransitioned },
    ]);
    expect(validateIntentSettlementVocabulary([], [entityUpdated])).toEqual([
      { kind: "generic_mutation", eventKind: entityUpdated },
    ]);
  });

  it("types concrete agent intents by closed intent kind", () => {
    const intent: AgentIntent<"agent.intent.submitted", { readonly text: string }> = {
      kind: "agent.intent.submitted",
      payload: { text: "hello" },
      intentRef: "intent/1",
      ...identity,
    };

    expect(intent.kind).toBe("agent.intent.submitted");
    expect(intent.payload.text).toBe("hello");
  });
});
