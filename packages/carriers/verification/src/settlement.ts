import type { ExtensionCapability } from "@agent-os/kernel/extensions";

import { VERIFICATION_EVENTS, type VerificationGateRecordedPayload } from "./events";

export const commitVerificationGateRecorded = (
  cap: ExtensionCapability,
  payload: VerificationGateRecordedPayload,
): Promise<{ readonly id: number }> =>
  cap.commit({ event: VERIFICATION_EVENTS.GATE_RECORDED, data: payload });
