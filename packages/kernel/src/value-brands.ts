import { Option } from "effect";

const untrustedBrand: unique symbol = Symbol("@agent-os/kernel/Untrusted");
const authoredBrand: unique symbol = Symbol("@agent-os/kernel/Authored");
const ledgerSafeBrand: unique symbol = Symbol("@agent-os/kernel/LedgerSafe");
const recordableBrand: unique symbol = Symbol("@agent-os/kernel/Recordable");
const recordedBrand: unique symbol = Symbol("@agent-os/kernel/Recorded");
const derivedBrand: unique symbol = Symbol("@agent-os/kernel/Derived");
const liveBrand: unique symbol = Symbol("@agent-os/kernel/Live");
const recordedPayloadBrand: unique symbol = Symbol("@agent-os/kernel/RecordedPayload");

export interface Untrusted<T> {
  readonly value: T;
  readonly [untrustedBrand]: "Untrusted";
}

export interface Authored<T> {
  readonly value: T;
  readonly [authoredBrand]: "Authored";
}

export interface LedgerSafe<T> {
  readonly value: T;
  readonly [ledgerSafeBrand]: "LedgerSafe";
}

export interface Recordable<T> {
  readonly value: T;
  readonly [recordableBrand]: "Recordable";
}

export interface Recorded<T> {
  readonly value: T;
  readonly [recordedBrand]: "Recorded";
}

export interface Derived<T> {
  readonly value: T;
  readonly [derivedBrand]: "Derived";
}

export interface Live<T> {
  readonly [liveBrand]: { readonly Live: T };
}

export type RecordedPayloadValue =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<RecordedPayloadValue>
  | { readonly [key: string]: RecordedPayloadValue };

export type RecordedPayload = Readonly<Record<string, RecordedPayloadValue>> & {
  readonly [recordedPayloadBrand]: "RecordedPayload";
};

export type UntrustedValue<T extends object> = T & Untrusted<T>;
export type AuthoredValue<T extends object> = T & Authored<T>;
export type LedgerSafeValue<T extends object> = T & LedgerSafe<T>;
export type RecordableValue<T extends object> = T & Recordable<T>;
export type RecordedValue<T extends object> = T & Recorded<T>;
export type DerivedValue<T extends object> = T & Derived<T>;

const failConstruction = (message: string): never =>
  Option.getOrThrowWith(Option.none(), () => new TypeError(message));

const domainBrands = [
  untrustedBrand,
  authoredBrand,
  ledgerSafeBrand,
  recordableBrand,
  recordedBrand,
  derivedBrand,
] as const;

const cloneObjectWithDescriptors = <T extends object>(value: T): T => {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const existingDomainBrand = domainBrands.some(
    (brand) => Object.getOwnPropertyDescriptor(value, brand) !== undefined,
  );
  if (descriptors.value !== undefined && !existingDomainBrand) {
    return failConstruction("value-domain evidence cannot overwrite an existing value field");
  }
  Reflect.deleteProperty(descriptors, "value");
  for (const brand of domainBrands) Reflect.deleteProperty(descriptors, brand);
  return Object.defineProperties(Object.create(Object.getPrototypeOf(value)) as T, descriptors);
};

const isJsonRecord = (value: object): value is Readonly<Record<string, unknown>> => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const domainValue = <T extends object, Brand extends string>(
  value: T,
  brand: (typeof domainBrands)[number],
  brandName: Brand,
): T & { readonly value: T } => {
  const branded = cloneObjectWithDescriptors(value) as T & { readonly value: T };
  Object.defineProperty(branded, "value", { value, enumerable: false });
  Object.defineProperty(branded, brand, { value: brandName, enumerable: false });
  return branded;
};

export const untrustedValue = <T extends object>(value: T): UntrustedValue<T> =>
  domainValue(value, untrustedBrand, "Untrusted") as UntrustedValue<T>;

export const authoredValue = <T extends object>(value: T): AuthoredValue<T> => {
  return domainValue(value, authoredBrand, "Authored") as AuthoredValue<T>;
};

export const ledgerSafeValue = <T extends object>(value: T): LedgerSafeValue<T> =>
  domainValue(value, ledgerSafeBrand, "LedgerSafe") as LedgerSafeValue<T>;

export const recordableValue = <T extends object>(value: T): RecordableValue<T> =>
  domainValue(value, recordableBrand, "Recordable") as RecordableValue<T>;

export const recordedValue = <T extends object>(value: T): RecordedValue<T> =>
  domainValue(value, recordedBrand, "Recorded") as RecordedValue<T>;

export const derivedValue = <T extends object>(value: T): DerivedValue<T> =>
  domainValue(value, derivedBrand, "Derived") as DerivedValue<T>;

const cloneRecordedPayloadValue = (value: unknown): RecordedPayloadValue => {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    return failConstruction("recorded payload number must be finite");
  }
  if (Array.isArray(value)) return value.map(cloneRecordedPayloadValue);
  if (typeof value === "object" && value !== null) {
    if (!isJsonRecord(value)) {
      return failConstruction("recorded payload object must be a JSON record");
    }
    const clone: Record<string, RecordedPayloadValue> = {};
    const record = value as Readonly<Record<string, unknown>>;
    for (const key of Object.keys(record)) {
      clone[key] = cloneRecordedPayloadValue(record[key]);
    }
    return clone;
  }
  return failConstruction(`recorded payload value invalid: ${typeof value}`);
};

export const recordedPayload = (value: Readonly<Record<string, unknown>>): RecordedPayload => {
  const payload = cloneRecordedPayloadValue(value);
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return failConstruction("recorded payload must be an object");
  }
  Object.defineProperty(payload, recordedPayloadBrand, {
    value: "RecordedPayload",
    enumerable: false,
  });
  return payload as RecordedPayload;
};
