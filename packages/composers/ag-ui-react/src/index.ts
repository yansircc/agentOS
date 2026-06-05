import { useMemo, useSyncExternalStore } from "react";
import {
  createAgUiFrameStore,
  projectAgUiFrames,
  type AgUiFrame,
  type AgUiFrameProjection,
  type AgUiFrameStore,
} from "@agent-os/ag-ui";

export type { AgUiFrame, AgUiFrameProjection, AgUiFrameStore } from "@agent-os/ag-ui";

export const useAgUiProjection = (frames: ReadonlyArray<AgUiFrame>): AgUiFrameProjection =>
  useMemo(() => projectAgUiFrames(frames), [frames]);

export const createAgUiReactFrameStore = (
  initialFrames: Iterable<AgUiFrame> = [],
): AgUiFrameStore => createAgUiFrameStore(initialFrames);

export const useAgUiFrameStore = (store: AgUiFrameStore): AgUiFrameProjection =>
  useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
