import { describe, expect, it } from "vite-plus/test";

import * as kernel from "../src";
import type { Authored, Live, Recorded, RecordedPayload, SafeLedgerPayload } from "../src";

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

  it("does not expose generic runtime constructors for value-domain brands", () => {
    expect("Authored" in kernel).toBe(false);
    expect("Recorded" in kernel).toBe(false);
    expect("Live" in kernel).toBe(false);
    expect("RecordedPayload" in kernel).toBe(false);
  });
});
