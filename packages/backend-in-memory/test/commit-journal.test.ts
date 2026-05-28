import { describe, expect, it } from "vite-plus/test";
import { createInMemoryCommitJournal } from "../src";

describe("in-memory CommitJournal", () => {
  it("fires inserted events exactly once after a successful commit", async () => {
    const journal = createInMemoryCommitJournal();
    const fired: string[] = [];
    journal.subscribe((event) => fired.push(`${event.id}:${event.kind}`));

    const result = await journal.transact((tx) => {
      tx.appendEvent({ kind: "example.recorded", scope: "s1", payload: { ok: true }, ts: 1 });
      tx.appendEvent({ kind: "example.done", scope: "s1", payload: { ok: true }, ts: 2 });
      return "committed";
    });

    expect(result.value).toBe("committed");
    expect(result.events.map((event) => event.id)).toEqual([1, 2]);
    expect(fired).toEqual(["1:example.recorded", "2:example.done"]);
    await expect(journal.events({ scope: "s1" })).resolves.toHaveLength(2);
  });

  it("does not persist or fan out staged events when a transaction throws", async () => {
    const journal = createInMemoryCommitJournal();
    const fired: string[] = [];
    journal.subscribe((event) => fired.push(event.kind));

    await expect(
      journal.transact((tx) => {
        tx.appendEvent({ kind: "example.recorded", scope: "s1", payload: {}, ts: 1 });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");

    expect(fired).toEqual([]);
    await expect(journal.events()).resolves.toEqual([]);
    const next = await journal.transact((tx) =>
      tx.appendEvent({ kind: "example.after", scope: "s1", payload: {}, ts: 2 }),
    );
    expect(next.events[0]?.id).toBe(1);
  });
});
