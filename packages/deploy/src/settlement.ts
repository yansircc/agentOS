import type { ExtensionCapability } from "@agent-os/kernel/extensions";

import {
  DEPLOY_EVENTS,
  type DeployFailedPayload,
  type DeployPreviewRecordedPayload,
  type DeployProductionPromotedPayload,
  type DeployProductionReadbackPayload,
  type DeployRollbackRecordedPayload,
} from "./events";

export const commitDeployPreviewRecorded = (
  cap: ExtensionCapability,
  payload: DeployPreviewRecordedPayload,
): Promise<{ readonly id: number }> =>
  cap.commit({ event: DEPLOY_EVENTS.PREVIEW_RECORDED, data: payload });

export const commitDeployProductionPromoted = (
  cap: ExtensionCapability,
  payload: DeployProductionPromotedPayload,
): Promise<{ readonly id: number }> =>
  cap.commit({ event: DEPLOY_EVENTS.PRODUCTION_PROMOTED, data: payload });

export const commitDeployProductionReadback = (
  cap: ExtensionCapability,
  payload: DeployProductionReadbackPayload,
): Promise<{ readonly id: number }> =>
  cap.commit({ event: DEPLOY_EVENTS.PRODUCTION_READBACK, data: payload });

export const commitDeployRollbackRecorded = (
  cap: ExtensionCapability,
  payload: DeployRollbackRecordedPayload,
): Promise<{ readonly id: number }> =>
  cap.commit({ event: DEPLOY_EVENTS.ROLLBACK_RECORDED, data: payload });

export const commitDeployFailed = (
  cap: ExtensionCapability,
  payload: DeployFailedPayload,
): Promise<{ readonly id: number }> => cap.commit({ event: DEPLOY_EVENTS.FAILED, data: payload });
