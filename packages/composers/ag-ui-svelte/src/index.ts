import { readable, derived, type Readable } from "svelte/store";
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

export const createAgUiSvelteFrameStore = (
  initialFrames: Iterable<AgUiFrame> = [],
): {
  readonly store: AgUiFrameStore;
  readonly frames: Readable<ReadonlyArray<AgUiFrame>>;
  readonly projection: Readable<AgUiFrameProjection>;
  readonly activities: Readable<ReadonlyArray<AgUiActivity>>;
} => {
  const store = createAgUiFrameStore(initialFrames);
  const frames = readable(store.getFrames(), (set) =>
    store.subscribe(() => {
      set(store.getFrames());
    }),
  );
  return {
    store,
    frames,
    projection: derived(frames, ($frames) => projectAgUiFrames($frames)),
    activities: derived(frames, ($frames) => projectAgUiFramesToActivities($frames)),
  };
};

export const agUiProjectionReadable = (
  frames: ReadonlyArray<AgUiFrame>,
): Readable<AgUiFrameProjection> => readable(projectAgUiFrames(frames));

export const agUiActivitiesReadable = (
  frames: ReadonlyArray<AgUiFrame>,
): Readable<ReadonlyArray<AgUiActivity>> => readable(projectAgUiFramesToActivities(frames));
