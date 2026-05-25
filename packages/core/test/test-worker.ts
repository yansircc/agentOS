/**
 * Minimal test worker entry.
 *
 * The DO binding in wrangler-test.jsonc points here. TestAgentDO extends the
 * raw `DurableObject` (NOT AgentDOBase) so contract tests can compose the
 * substrate's internal Layers manually inside runInDurableObject(stub,
 * (instance, state) => { ... }) and bypass AgentDOBase.submit. This gives
 * tests full control over which AiBinding implementation is provided —
 * a stub — without polluting the production substrate API.
 *
 * The default fetch handler exists only to satisfy the Workers runtime
 * requirement that a worker has a default export; tests never call it.
 */

import { DurableObject } from "cloudflare:workers";

export class TestAgentDO extends DurableObject {}

export default {
  async fetch(): Promise<Response> {
    return new Response("@agent-os/core test worker (not for direct use)");
  },
};
