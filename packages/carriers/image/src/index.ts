/**
 * @agent-os/image — image namespace and projection algebra.
 *
 * This package reserves image.* vocabulary and exports pure projection,
 * idempotency, and settlement helpers. It does not own provider transport,
 * ledger writes, resource ledgers, blob storage, R2 key policy, retention,
 * public URLs, or provider fallback.
 */

export * from "./extension";
export * from "./events";
export * from "./idempotency";
export * from "./settlement";
