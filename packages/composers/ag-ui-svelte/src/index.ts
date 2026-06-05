import { readable, derived, type Readable } from "svelte/store";
import {
  createAgUiFrameStore,
  projectAgUiFrames,
  type AgUiFrame,
  type AgUiFrameProjection,
  type AgUiFrameStore,
} from "@agent-os/ag-ui";

export type { AgUiFrame, AgUiFrameProjection, AgUiFrameStore } from "@agent-os/ag-ui";

export const createAgUiSvelteFrameStore = (
  initialFrames: Iterable<AgUiFrame> = [],
): {
  readonly store: AgUiFrameStore;
  readonly frames: Readable<ReadonlyArray<AgUiFrame>>;
  readonly projection: Readable<AgUiFrameProjection>;
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
  };
};

export const agUiProjectionReadable = (
  frames: ReadonlyArray<AgUiFrame>,
): Readable<AgUiFrameProjection> => readable(projectAgUiFrames(frames));
