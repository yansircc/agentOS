import type { Live } from "./value-brands";

const LIVE_VALUE = Symbol("@agent-os/kernel/LiveValue");

type LiveBox<T> = {
  readonly [LIVE_VALUE]: T;
};

/**
 * Captures live runtime material behind the non-recorded `Live<T>` brand.
 * This edge is intentionally exported only through `@agent-os/kernel/live-edge`,
 * not the kernel root, so runtime/provider interpreters can consume live
 * material without making it a ledger-visible value.
 *
 * @public
 */
export const captureLive = <T>(value: T): Live<T> =>
  Object.freeze(Object.defineProperty({}, LIVE_VALUE, { value, enumerable: false })) as Live<T>;

/**
 * Opens trusted live runtime material at interpreter boundaries.
 *
 * @public
 */
export const openLive = <T>(value: Live<T>): T => (value as unknown as LiveBox<T>)[LIVE_VALUE];
