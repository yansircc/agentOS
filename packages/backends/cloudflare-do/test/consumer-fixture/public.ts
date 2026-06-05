/// <reference types="@cloudflare/workers-types" />

import { defineAgentDO, type CloudflareAgentEnv } from "@agent-os/backend-cloudflare-do";
import {
  durableObjectRpcClient,
  type DurableObjectRpcClient,
} from "@agent-os/backend-cloudflare-do/do-rpc";
import { triggerParseOk, type TriggerTx } from "@agent-os/runtime";
import { Effect } from "effect";
import type { LedgerEventRpc } from "@agent-os/kernel/types";

interface Intent {
  readonly ok: true;
}

const trigger = {
  kind: "fixture.trigger",
  intentEventKind: "fixture.trigger.requested",
  cancellation: "cooperative" as const,
  parseIntent: () => triggerParseOk<Intent>({ ok: true }),
  acquire: (intent: Intent) => Effect.succeed(intent),
  commit: (outcome: Intent, tx: TriggerTx) => {
    tx.insertEvent({ kind: "fixture.trigger.done", payload: outcome });
  },
  commitCancelled: () => undefined,
};

export const FixtureDO = defineAgentDO<CloudflareAgentEnv>({
  bindings: [],
  triggers: [trigger],
});

interface FixtureRpcProtocol {
  readonly ping: (input: { readonly value: string }) => Promise<string>;
}

export const fixtureRpcClient = (
  namespace: DurableObjectNamespace,
): DurableObjectRpcClient<FixtureRpcProtocol> =>
  durableObjectRpcClient<FixtureRpcProtocol>(namespace, "fixture");

export const firstKind = (events: ReadonlyArray<LedgerEventRpc>): string | null =>
  events[0]?.kind ?? null;
