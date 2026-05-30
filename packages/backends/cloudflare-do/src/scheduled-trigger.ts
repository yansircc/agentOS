import { Effect } from "effect";
import {
  DURABLE_TRIGGER_SCHEDULED_REQUESTED,
  parseScheduledEventIntentPayload,
  type ScheduledEventIntentPayload,
} from "@agent-os/backend-protocol";
import { triggerParseFail, triggerParseOk, type DurableTrigger } from "@agent-os/runtime";

export const scheduledEventTrigger = {
  kind: "scheduled_event",
  intentEventKind: DURABLE_TRIGGER_SCHEDULED_REQUESTED,
  parseIntent: (raw: unknown) => {
    const parsed = parseScheduledEventIntentPayload(raw);
    return parsed.ok ? triggerParseOk(parsed.value) : triggerParseFail(parsed.failure.reason);
  },
  acquire: (intent: ScheduledEventIntentPayload) => Effect.succeed(intent),
  commit: (outcome, tx) => {
    tx.insertEvent({
      kind: outcome.eventKind,
      payload: outcome.data,
    });
  },
} satisfies DurableTrigger<ScheduledEventIntentPayload, ScheduledEventIntentPayload>;
