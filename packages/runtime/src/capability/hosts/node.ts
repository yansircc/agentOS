/**
 * Node.js host profile
 * @public
 */

import { defineHost } from "../host";

/**
 * Node.js host profile
 * @public
 */
export const nodeHost = defineHost({
  target: "node@1",
  provides: [
    "storage.ledger",
    "fs.workspace",
    "timer.durable",
    "network.outbound",
    "secrets.store",
    "eventLoop.durable",
    "llm.anthropic",
    "llm.openai",
  ],
  materialize: () => ({}),
});
