export type DecodeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly cause: unknown };

export const decodeOk = <T>(value: T): DecodeResult<T> => ({ ok: true, value });

export const decodeFail = <T = never>(message: string): DecodeResult<T> => ({
  ok: false,
  cause: new TypeError(message),
});

export const recordOf = (value: unknown, label: string): DecodeResult<Record<string, unknown>> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return decodeFail(`${label} must be object`);
  }
  return decodeOk(value as Record<string, unknown>);
};

export const finiteNumberField = (
  record: Record<string, unknown>,
  field: string,
): DecodeResult<number> => {
  const value = record[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return decodeFail(`${field} must be finite number`);
  }
  return decodeOk(value);
};

export const stringField = (
  record: Record<string, unknown>,
  field: string,
): DecodeResult<string> => {
  const value = record[field];
  if (typeof value !== "string") return decodeFail(`${field} must be string`);
  return decodeOk(value);
};
