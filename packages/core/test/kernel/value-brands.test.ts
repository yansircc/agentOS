import { describe, expect, it } from "vite-plus/test";

import * as kernel from "../../src";
import type {
  Authored,
  Derived,
  LedgerSafe,
  Live,
  Recordable,
  Recorded,
  RecordedLedgerEvent,
  RecordedPayload,
  SafeLedgerPayload,
  Untrusted,
} from "../../src";
import {
  authoredValue,
  derivedValue,
  ledgerSafeValue,
  recordedPayload,
  recordedValue,
  recordableValue,
  untrustedValue,
} from "../../src/value-brands";
import { safeLedgerPayload } from "../../src/safe-ledger-event";

describe("value domain brands", () => {
  it("keeps value domains in separate type domains", () => {
    type Payload = { readonly value: string };
    const untrusted = undefined as unknown as Untrusted<Payload>;
    const authored = undefined as unknown as Authored<Payload>;
    const ledgerSafe = undefined as unknown as LedgerSafe<Payload>;
    const recordable = undefined as unknown as Recordable<Payload>;
    const recorded = undefined as unknown as Recorded<Payload>;
    const derived = undefined as unknown as Derived<Payload>;
    const live = undefined as unknown as Live<Payload>;

    const assertTypeErrors = () => {
      // @ts-expect-error Untrusted input is not authored intent until an owner parser accepts it.
      const authoredFromUntrusted: Authored<Payload> = untrusted;
      // @ts-expect-error Authored intent cannot be used as Recorded truth.
      const recordedFromAuthored: Recorded<Payload> = authored;
      // @ts-expect-error Ledger-safe shape is not owner-accepted recordable truth.
      const recordableFromLedgerSafe: Recordable<Payload> = ledgerSafe;
      // @ts-expect-error Recordable truth is not yet ledger-witnessed Recorded truth.
      const recordedFromRecordable: Recorded<Payload> = recordable;
      // @ts-expect-error Recorded truth is not a derived projection.
      const derivedFromRecorded: Derived<Payload> = recorded;
      // @ts-expect-error Derived projections are not recorded truth.
      const recordedFromDerived: Recorded<Payload> = derived;
      // @ts-expect-error Live material cannot be used as Recorded truth without an owner codec.
      const recordedFromLive: Recorded<Payload> = live;
      // @ts-expect-error Recorded truth cannot be reopened as Live material by type assignment.
      const liveFromRecorded: Live<Payload> = recorded;
      // @ts-expect-error Live material has no public open slot.
      const openedLive = live.value;
      return [
        authoredFromUntrusted,
        recordedFromAuthored,
        recordableFromLedgerSafe,
        recordedFromRecordable,
        derivedFromRecorded,
        recordedFromDerived,
        recordedFromLive,
        liveFromRecorded,
        openedLive,
      ];
    };

    expect(typeof assertTypeErrors).toBe("function");
  });

  it("keeps RecordedPayload independent from browser-safe projections", () => {
    const safePayload: SafeLedgerPayload = safeLedgerPayload({ value: "visible-to-browser" });
    const recordedPayloadTruth = undefined as unknown as RecordedPayload;
    type Payload = { readonly kind: string; readonly id: number };

    const assertTypeErrors = () => {
      // @ts-expect-error SafeLedgerPayload is a projection, not Recorded payload truth.
      const recordedFromSafe: RecordedPayload = safePayload;
      // @ts-expect-error Plain JSON is not owner-minted browser-safe projection payload.
      const safeFromPlain: SafeLedgerPayload = { value: "visible-to-browser" };
      // @ts-expect-error Plain JSON does not carry the source-owned RecordedPayload brand.
      const recordedFromPlain: RecordedPayload = { value: "truth" };
      // @ts-expect-error RecordedPayload is opaque payload truth, not owner-accepted Recordable<T>.
      const recordableFromPayload: Recordable<Payload> = recordedPayloadTruth;
      // @ts-expect-error RecordedPayload is not a ledger-witnessed domain value.
      const recordedFromPayload: Recorded<Payload> = recordedPayloadTruth;
      return [
        recordedFromSafe,
        safeFromPlain,
        recordedFromPlain,
        recordableFromPayload,
        recordedFromPayload,
      ];
    };

    expect(typeof assertTypeErrors).toBe("function");
  });

  it("mints Authored and Recorded evidence without changing JSON shape", () => {
    const inbound = untrustedValue({ kind: "raw", name: "lookup" });
    const untrustedEvidence: Untrusted<{ readonly kind: string; readonly name: string }> = inbound;
    expect(untrustedEvidence.value.name).toBe("lookup");
    expect(JSON.stringify(inbound)).toBe('{"kind":"raw","name":"lookup"}');

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

  it("separates ledger-safe, recordable, recorded, and derived value domains", () => {
    const ledgerSafe = ledgerSafeValue({ kind: "json", id: 1 });
    const ledgerSafeEvidence: LedgerSafe<{ readonly kind: string; readonly id: number }> =
      ledgerSafe;
    expect(ledgerSafeEvidence.value.id).toBe(1);
    expect(JSON.stringify(ledgerSafe)).toBe('{"kind":"json","id":1}');

    const recordable = recordableValue({ kind: "owner.accepted", id: 2 });
    const recordableEvidence: Recordable<{ readonly kind: string; readonly id: number }> =
      recordable;
    expect(recordableEvidence.value.id).toBe(2);
    expect(JSON.stringify(recordable)).toBe('{"kind":"owner.accepted","id":2}');

    const recorded = recordedValue(recordable.value);
    const recordedEvidence: Recorded<{ readonly kind: string; readonly id: number }> = recorded;
    expect(recordedEvidence.value.id).toBe(2);
    expect(JSON.stringify(recorded)).toBe('{"kind":"owner.accepted","id":2}');

    const derived = derivedValue({ kind: "projection", id: 3 });
    const derivedEvidence: Derived<{ readonly kind: string; readonly id: number }> = derived;
    expect(derivedEvidence.value.id).toBe(3);
    expect(JSON.stringify(derived)).toBe('{"kind":"projection","id":3}');
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

  it("mints SafeLedgerPayload through the browser-safe projection contract", () => {
    const payload = safeLedgerPayload({
      path: "README.md",
      nested: { ok: true, bytes: 12 },
    });
    const safe: SafeLedgerPayload = payload;

    expect(safe.path).toBe("README.md");
    expect(JSON.stringify(safe)).toBe('{"path":"README.md","nested":{"ok":true,"bytes":12}}');
    expect(() => safeLedgerPayload({ bad: Number.NaN })).toThrow(
      "safe ledger payload must be JSON-safe",
    );
    expect(() => safeLedgerPayload({ bad: undefined })).toThrow(
      "safe ledger payload must be JSON-safe",
    );
    expect(() => safeLedgerPayload({ bad: new Date(0) })).toThrow(
      "safe ledger payload must be JSON-safe",
    );
  });

  it("decodes ledger rows into Recorded ledger facts", () => {
    const fact = kernel.decodeRecordedLedgerEvent({
      id: 1,
      ts: 10,
      kind: "agent.run.started",
      scopeRef: { kind: "conversation", scopeId: "recorded-ledger" },
      factOwnerRef: "@agent-os/test",
      effectAuthorityRef: { authorityClass: "test", authorityId: "recorded-ledger" },
      payload: { runId: 1 },
    });
    const recorded: RecordedLedgerEvent = fact;

    expect(recorded.value.id).toBe(1);
    expect(Object.prototype.propertyIsEnumerable.call(fact, "value")).toBe(false);
    expect(JSON.stringify(fact)).not.toContain('"value"');
    expect(() => kernel.decodeRecordedLedgerEvent({ id: "1", payload: {} })).toThrow();
    expect(JSON.stringify(kernel.decodeRecordedLedgerEventOption({ id: "1", payload: {} }))).toBe(
      '{"_id":"Option","_tag":"None"}',
    );
  });

  it("does not expose generic runtime constructors for value-domain brands", () => {
    expect("Authored" in kernel).toBe(false);
    expect("Derived" in kernel).toBe(false);
    expect("LedgerSafe" in kernel).toBe(false);
    expect("Recorded" in kernel).toBe(false);
    expect("Recordable" in kernel).toBe(false);
    expect("Live" in kernel).toBe(false);
    expect("RecordedPayload" in kernel).toBe(false);
    expect("Untrusted" in kernel).toBe(false);
    expect("authoredValue" in kernel).toBe(false);
    expect("derivedValue" in kernel).toBe(false);
    expect("ledgerSafeValue" in kernel).toBe(false);
    expect("recordedValue" in kernel).toBe(false);
    expect("recordableValue" in kernel).toBe(false);
    expect("recordedPayload" in kernel).toBe(false);
    expect("untrustedValue" in kernel).toBe(false);
  });
});
