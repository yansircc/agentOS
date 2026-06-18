import { describe, expect, it } from "vite-plus/test";

import * as kernel from "../src";
import type { Authored, Live, Recorded, RecordedPayload, SafeLedgerPayload } from "../src";
import { authoredValue, recordedPayload, recordedValue } from "../src/value-brands";

describe("value domain brands", () => {
  it("keeps Authored, Recorded, and Live in separate type domains", () => {
    type Payload = { readonly value: string };
    const authored = undefined as unknown as Authored<Payload>;
    const recorded = undefined as unknown as Recorded<Payload>;
    const live = undefined as unknown as Live<Payload>;

    const assertTypeErrors = () => {
      // @ts-expect-error Authored intent cannot be used as Recorded truth.
      const recordedFromAuthored: Recorded<Payload> = authored;
      // @ts-expect-error Live material cannot be used as Recorded truth without an owner codec.
      const recordedFromLive: Recorded<Payload> = live;
      // @ts-expect-error Recorded truth cannot be reopened as Live material by type assignment.
      const liveFromRecorded: Live<Payload> = recorded;
      // @ts-expect-error Live material has no public open slot.
      const openedLive = live.value;
      return [recordedFromAuthored, recordedFromLive, liveFromRecorded, openedLive];
    };

    expect(typeof assertTypeErrors).toBe("function");
  });

  it("keeps RecordedPayload independent from browser-safe projections", () => {
    const safePayload: SafeLedgerPayload = { value: "visible-to-browser" };

    const assertTypeErrors = () => {
      // @ts-expect-error SafeLedgerPayload is a projection, not Recorded payload truth.
      const recordedFromSafe: RecordedPayload = safePayload;
      // @ts-expect-error Plain JSON does not carry the source-owned RecordedPayload brand.
      const recordedFromPlain: RecordedPayload = { value: "truth" };
      return [recordedFromSafe, recordedFromPlain];
    };

    expect(typeof assertTypeErrors).toBe("function");
  });

  it("mints Authored and Recorded evidence without changing JSON shape", () => {
    const intent = authoredValue({ kind: "tool", name: "lookup" });
    const intentEvidence: Authored<{ readonly kind: string; readonly name: string }> = intent;

    expect(intentEvidence.value.name).toBe("lookup");
    expect(Object.prototype.propertyIsEnumerable.call(intent, "value")).toBe(false);
    expect(JSON.stringify(intent)).toBe('{"kind":"tool","name":"lookup"}');

    const fact = recordedValue({ kind: "ledger.event", id: 1 });
    const factEvidence: Recorded<{ readonly kind: string; readonly id: number }> = fact;

    expect(factEvidence.value.id).toBe(1);
    expect(Object.prototype.propertyIsEnumerable.call(fact, "value")).toBe(false);
    expect(JSON.stringify(fact)).toBe('{"kind":"ledger.event","id":1}');

    expect(() => authoredValue({ kind: "payload", value: 1 })).toThrow(
      "cannot overwrite an existing value field",
    );
    expect(authoredValue(intent).value.name).toBe("lookup");
  });

  it("mints RecordedPayload from JSON-compatible payloads only", () => {
    const payload = recordedPayload({
      scope: "run-1",
      nested: { ok: true, count: 1, values: ["a", null] },
    });
    const recorded: RecordedPayload = payload;

    expect(recorded.scope).toBe("run-1");
    expect(JSON.stringify(recorded)).toBe(
      '{"scope":"run-1","nested":{"ok":true,"count":1,"values":["a",null]}}',
    );
    expect(() => recordedPayload({ bad: Number.NaN })).toThrow("recorded payload number");
    expect(() => recordedPayload({ bad: undefined })).toThrow("recorded payload value invalid");
    expect(() => recordedPayload({ bad: new Date(0) })).toThrow(
      "recorded payload object must be a JSON record",
    );
  });

  it("does not expose generic runtime constructors for value-domain brands", () => {
    expect("Authored" in kernel).toBe(false);
    expect("Recorded" in kernel).toBe(false);
    expect("Live" in kernel).toBe(false);
    expect("RecordedPayload" in kernel).toBe(false);
    expect("authoredValue" in kernel).toBe(false);
    expect("recordedValue" in kernel).toBe(false);
    expect("recordedPayload" in kernel).toBe(false);
  });
});
