import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import type { AgUiFrame } from "@agent-os/ag-ui";
import { createAgUiSvelteFrameStore } from "../src/index";

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

describe("@agent-os/ag-ui-svelte", () => {
  it("consumes the shared AG-UI frame stream through Svelte stores", () => {
    const { store, projection, activities } = createAgUiSvelteFrameStore(frames);
    const snapshots: unknown[] = [];
    const activitySnapshots: unknown[] = [];
    const unsubscribe = projection.subscribe((value) => {
      snapshots.push(value);
    });
    const unsubscribeActivities = activities.subscribe((value) => {
      activitySnapshots.push(value);
    });
    store.append({ type: "RUN_FINISHED", threadId: "thread-1", runId: "1" });
    unsubscribeActivities();
    unsubscribe();
    expect(snapshots.at(0)).toMatchObject({
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
    expect(snapshots.at(-1)).toMatchObject({ status: "completed" });
    expect(activitySnapshots.at(-1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "message", text: "Hello" }),
        expect.objectContaining({ kind: "tool_call", status: "completed" }),
      ]),
    );
  });

  it("does not import runtime events or raw ledger payload surfaces", () => {
    const source = readFileSync(resolve("src/index.ts"), "utf8");
    expect(source).not.toContain("@agent-os/runtime");
    expect(source).not.toContain("decodeRuntimeLedgerEvent");
    expect(source).not.toContain("RUNTIME_EVENT_KIND");
    expect(source).not.toContain(".payload");
  });
});
