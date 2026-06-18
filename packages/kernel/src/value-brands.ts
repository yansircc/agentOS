import { Option } from "effect";

const authoredBrand: unique symbol = Symbol("@agent-os/kernel/Authored");
const recordedBrand: unique symbol = Symbol("@agent-os/kernel/Recorded");
const liveBrand: unique symbol = Symbol("@agent-os/kernel/Live");
const recordedPayloadBrand: unique symbol = Symbol("@agent-os/kernel/RecordedPayload");

export interface Authored<T> {
  readonly value: T;
  readonly [authoredBrand]: "Authored";
}

export interface Recorded<T> {
  readonly value: T;
  readonly [recordedBrand]: "Recorded";
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

export type AuthoredValue<T extends object> = T & Authored<T>;
export type RecordedValue<T extends object> = T & Recorded<T>;

const failConstruction = (message: string): never =>
  Option.getOrThrowWith(Option.none(), () => new TypeError(message));

const cloneObjectWithDescriptors = <T extends object>(value: T): T => {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const existingDomainBrand =
    Object.getOwnPropertyDescriptor(value, authoredBrand) !== undefined ||
    Object.getOwnPropertyDescriptor(value, recordedBrand) !== undefined;
  if (descriptors.value !== undefined && !existingDomainBrand) {
    return failConstruction("value-domain evidence cannot overwrite an existing value field");
  }
  Reflect.deleteProperty(descriptors, "value");
  Reflect.deleteProperty(descriptors, authoredBrand);
  Reflect.deleteProperty(descriptors, recordedBrand);
  return Object.defineProperties(Object.create(Object.getPrototypeOf(value)) as T, descriptors);
};

const isJsonRecord = (value: object): value is Readonly<Record<string, unknown>> => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

export const authoredValue = <T extends object>(value: T): AuthoredValue<T> => {
  const authored = cloneObjectWithDescriptors(value) as T & { readonly value: T };
  Object.defineProperty(authored, "value", { value, enumerable: false });
  Object.defineProperty(authored, authoredBrand, { value: "Authored", enumerable: false });
  return authored as AuthoredValue<T>;
};

export const recordedValue = <T extends object>(value: T): RecordedValue<T> => {
  const recorded = cloneObjectWithDescriptors(value) as T & { readonly value: T };
  Object.defineProperty(recorded, "value", { value, enumerable: false });
  Object.defineProperty(recorded, recordedBrand, { value: "Recorded", enumerable: false });
  return recorded as RecordedValue<T>;
};

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
