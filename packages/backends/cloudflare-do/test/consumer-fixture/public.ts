import { defineAgentDO, type CloudflareAgentEnv } from "@agent-os/backend-cloudflare-do";
import { withAgentDOTestingDrain } from "@agent-os/backend-cloudflare-do/testing";
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

const FixtureDO = defineAgentDO<CloudflareAgentEnv>({
  bindings: [],
  triggers: [trigger],
});

export const TestingFixtureDO = withAgentDOTestingDrain(FixtureDO);

export const firstKind = (events: ReadonlyArray<LedgerEventRpc>): string | null =>
  events[0]?.kind ?? null;
