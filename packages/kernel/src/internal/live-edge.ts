import type { Live } from "../value-brands";

export const captureLive = <T>(value: T): Live<T> => value as unknown as Live<T>;

export const openLive = <T>(value: Live<T>): T => value as unknown as T;
