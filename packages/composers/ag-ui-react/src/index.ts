import { useMemo, useSyncExternalStore } from "react";
import {
  createAgUiFrameStore,
  projectAgUiFramesToActivities,
  projectAgUiFrames,
  type AgUiActivity,
  type AgUiFrame,
  type AgUiFrameProjection,
  type AgUiFrameStore,
} from "@agent-os/ag-ui";

export type { AgUiActivity, AgUiFrame, AgUiFrameProjection, AgUiFrameStore } from "@agent-os/ag-ui";

export const useAgUiProjection = (frames: ReadonlyArray<AgUiFrame>): AgUiFrameProjection =>
  useMemo(() => projectAgUiFrames(frames), [frames]);

export const useAgUiActivities = (frames: ReadonlyArray<AgUiFrame>): ReadonlyArray<AgUiActivity> =>
  useMemo(() => projectAgUiFramesToActivities(frames), [frames]);

export const createAgUiReactFrameStore = (
  initialFrames: Iterable<AgUiFrame> = [],
): AgUiFrameStore => createAgUiFrameStore(initialFrames);

export const useAgUiFrameStore = (store: AgUiFrameStore): AgUiFrameProjection =>
  useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
