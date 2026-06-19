import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { createAgentClientStore } from "@agent-os/client";
import { clientReadable, selectClientReadable } from "../src/index";

describe("@agent-os/client-svelte", () => {
  it("adapts the core client store into Svelte readables", () => {
    const store = createAgentClientStore({ count: 0 });
    const snapshots: Array<{ readonly count: number }> = [];
    const selected: number[] = [];

    const unsubscribe = clientReadable(store).subscribe((snapshot) => {
      snapshots.push(snapshot);
    });
    const unsubscribeSelected = selectClientReadable(store, (snapshot) => snapshot.count).subscribe(
      (value) => {
        selected.push(value);
      },
    );

    store.setSnapshot({ count: 1 });
    unsubscribeSelected();
    unsubscribe();

    expect(snapshots).toEqual([{ count: 0 }, { count: 1 }]);
    expect(selected).toEqual([0, 1]);
  });

  it("does not import AG-UI or declare local UI read-models", () => {
    const source = readFileSync(resolve("src/index.ts"), "utf8");
    expect(source).toContain("svelte/store");
    expect(source).toContain("@agent-os/client");
    expect(source).not.toContain("@agent-os/ag-ui");
    expect(source).not.toMatch(/\bexport\s+interface\s+[A-Za-z_$][\w$]*[^{]*\{/u);
    expect(source).not.toMatch(/\bexport\s+type\s+[A-Za-z_$][\w$]*[^=]*=\s*\{/u);
  });
});
