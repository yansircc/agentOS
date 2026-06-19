import { describe, expect, it } from "vite-plus/test";
import { createAgentClientStore, selectAgentClientSnapshot } from "../src/index";

describe("@agent-os/client", () => {
  it("owns a framework-neutral subscribe/getSnapshot store contract", () => {
    const store = createAgentClientStore({ count: 0 });
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });

    store.setSnapshot({ count: 1 });
    unsubscribe();
    store.setSnapshot({ count: 2 });

    expect(notifications).toBe(1);
    expect(store.getSnapshot()).toEqual({ count: 2 });
    expect(selectAgentClientSnapshot(store, (snapshot) => snapshot.count)).toBe(2);
  });
});
