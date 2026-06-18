declare const authoredBrand: unique symbol;
declare const recordedBrand: unique symbol;
declare const liveBrand: unique symbol;
declare const recordedPayloadBrand: unique symbol;

export interface Authored<T> {
  readonly value: T;
  readonly [authoredBrand]: "Authored";
}

export interface Recorded<T> {
  readonly value: T;
  readonly [recordedBrand]: "Recorded";
}

export interface Live<T> {
  readonly value: T;
  readonly [liveBrand]: "Live";
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
