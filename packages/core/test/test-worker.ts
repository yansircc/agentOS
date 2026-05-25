/**
 * Test worker entry — exposes two DO classes:
 *
 *   TestAgentDO  — raw DurableObject. Quota contract tests bypass
 *                  AgentDOBase entirely and compose Layers manually inside
 *                  runInDurableObject(stub, (instance, state) => { ... })
 *                  so they can stub the AiBinding deterministically.
 *
 *   EmitTestDO   — extends AgentDOBase. emitEvent contract tests exercise
 *                  the public surface directly (stub.emitEvent(...)) and
 *                  verify the reactive triad: now-write commits a ledger
 *                  row AND fires registered on() handlers in the same DO
 *                  invocation. The constructor wires one handler whose
 *                  side-effect is itself an emitEvent — proving handler →
 *                  handler chaining via the ledger.
 *
 * The fetch handler exists only to satisfy the Workers runtime
 * requirement that a worker has a default export.
 */

import { DurableObject } from "cloudflare:workers";
import { AgentDOBase, type AgentDOEnv } from "../src";

export class TestAgentDO extends DurableObject {}

export class EmitTestDO extends AgentDOBase<AgentDOEnv> {
  constructor(ctx: DurableObjectState, env: AgentDOEnv) {
    super(ctx, env);
    // Chain validation: emitting "interview.answer" triggers a handler
    // that emits "interview.followup". The contract test asserts both
    // rows appear in the ledger after one external emitEvent call.
    this.on("interview.answer", async (event) => {
      await this.emitEvent({
        event: "interview.followup",
        data: { sourceId: event.id, sourcePayload: event.payload },
      });
    });
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response("@agent-os/core test worker (not for direct use)");
  },
};
