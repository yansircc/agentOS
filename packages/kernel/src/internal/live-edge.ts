import type { Live } from "../value-brands";

const LIVE_VALUE = Symbol("@agent-os/kernel/LiveValue");

type LiveBox<T> = {
  readonly [LIVE_VALUE]: T;
};

export const captureLive = <T>(value: T): Live<T> =>
  Object.freeze(Object.defineProperty({}, LIVE_VALUE, { value, enumerable: false })) as Live<T>;

export const openLive = <T>(value: Live<T>): T => (value as unknown as LiveBox<T>)[LIVE_VALUE];
