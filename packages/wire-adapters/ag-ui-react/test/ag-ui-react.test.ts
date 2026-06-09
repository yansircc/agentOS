import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import type { AgUiFrame } from "@agent-os/ag-ui";
import { createAgUiReactFrameStore } from "../src/index";

const frames: ReadonlyArray<AgUiFrame> = [
  { type: "RUN_STARTED", threadId: "thread-1", runId: "1" },
  {
    type: "TEXT_MESSAGE_START",
    messageId: "m1",
    role: "assistant",
  },
  {
    type: "TEXT_MESSAGE_CONTENT",
    messageId: "m1",
    delta: "Hello",
  },
  { type: "TEXT_MESSAGE_END", messageId: "m1" },
  {
    type: "TOOL_CALL_START",
    toolCallId: "call-1",
    toolCallName: "lookup",
  },
  {
    type: "TOOL_CALL_ARGS",
    toolCallId: "call-1",
    delta: '{"city":"SF"}',
  },
  { type: "TOOL_CALL_END", toolCallId: "call-1" },
  {
    type: "TOOL_CALL_RESULT",
    messageId: "tool-result-1",
    toolCallId: "call-1",
    content: '{"temperature":71}',
    role: "tool",
  },
];

describe("@agent-os/ag-ui-react", () => {
  it("consumes the shared AG-UI frame stream through the core store", () => {
    const store = createAgUiReactFrameStore(frames);
    expect(store.getSnapshot()).toMatchObject({
      runId: "1",
      threadId: "thread-1",
      status: "running",
      text: "Hello",
      toolCalls: [
        {
          toolCallId: "call-1",
          name: "lookup",
          args: '{"city":"SF"}',
          result: '{"temperature":71}',
        },
      ],
    });
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });
    store.append({ type: "RUN_FINISHED", threadId: "thread-1", runId: "1" });
    unsubscribe();
    expect(notifications).toBe(1);
    expect(store.getSnapshot().status).toBe("completed");
  });

  it("does not import runtime events or raw ledger payload surfaces", () => {
    const source = readFileSync(resolve("src/index.ts"), "utf8");
    expect(source).toContain("useAgUiActivities");
    expect(source).not.toContain("@agent-os/runtime");
    expect(source).not.toContain("decodeRuntimeLedgerEvent");
    expect(source).not.toContain("RUNTIME_EVENT_KIND");
    expect(source).not.toContain(".payload");
  });
});
