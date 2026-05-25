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
 *   DispatchTestDO — extends AgentDOBase. dispatch contract tests use it
 *                    on both sender and receiver sides to validate
 *                    cross-scope delivery without app-level RPC.
 *
 * The fetch handler exists only to satisfy the Workers runtime
 * requirement that a worker has a default export.
 */

import { DurableObject } from "cloudflare:workers";
import {
  AgentDOBase,
  type AgentDOEnv,
  type DispatchTargetNamespace,
  type DispatchTargetRegistry,
} from "../src";

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

interface DispatchEnv extends AgentDOEnv {
  readonly DISPATCH_DO: DurableObjectNamespace<DispatchTestDO>;
}

const DEAD_TARGET: DispatchTargetNamespace = {
  idFromName: (_name) => ({}) as DurableObjectId,
  get: (_id) => ({
    __agentosReceiveDispatch: async () => {
      throw new Error("dead dispatch target");
    },
  }),
};

export class DispatchTestDO extends AgentDOBase<DispatchEnv> {
  constructor(ctx: DurableObjectState, env: DispatchEnv) {
    super(ctx, env);
    this.on("dispatch.inbound.accepted", async () => {
      await this.emitEvent({
        event: "dispatch.inbound.handler_fired",
        data: {},
      });
    });
    this.on("test.delivered", async (event) => {
      await this.emitEvent({
        event: "test.followup",
        data: { sourceId: event.id, sourcePayload: event.payload },
      });
    });
  }

  protected override provideDispatchTargets(): DispatchTargetRegistry {
    return {
      peer: this.env.DISPATCH_DO,
      dead: DEAD_TARGET,
    };
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response("@agent-os/core test worker (not for direct use)");
  },
};
