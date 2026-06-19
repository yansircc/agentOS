import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { createAgentClientStore } from "@agent-os/client";
import { useAgentClientSnapshot, useClientStore } from "../src/index";

describe("@agent-os/client-react", () => {
  it("exports React hooks over the core client store contract", () => {
    const store = createAgentClientStore({ status: "idle" });
    expect(store.getSnapshot()).toEqual({ status: "idle" });
    expect(typeof useAgentClientSnapshot).toBe("function");
    expect(typeof useClientStore).toBe("function");
  });

  it("does not import AG-UI or declare local UI read-models", () => {
    const source = readFileSync(resolve("src/index.ts"), "utf8");
    expect(source).toContain("useSyncExternalStore");
    expect(source).toContain("@agent-os/client");
    expect(source).not.toContain("@agent-os/ag-ui");
    expect(source).not.toMatch(/\bexport\s+interface\s+[A-Za-z_$][\w$]*[^{]*\{/u);
    expect(source).not.toMatch(/\bexport\s+type\s+[A-Za-z_$][\w$]*[^=]*=\s*\{/u);
  });
});
