import { recordedValue, type RecordedValue } from "@agent-os/core/recorded-value";

export type RuntimeProtocolRecorded<T extends object> = RecordedValue<T>;

export const recordRuntimeProtocolValue = <T extends object>(
  value: T,
): RuntimeProtocolRecorded<T> => recordedValue(value);
