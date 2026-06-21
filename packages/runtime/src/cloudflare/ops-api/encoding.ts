/**
 * @agent-os/runtime/cloudflare/ops-api — AttemptKey query encoding.
 *
 * AttemptKey is a 4-tuple with no hierarchy; it cannot be expressed in URL path
 * segments. Encoding: JSON-stringify -> base64url (no padding) -> single
 * `?key=` query param. Decode validates shape before returning.
 */

import type { AttemptKey } from "@agent-os/core/runtime-protocol";

// Strategy validation is intentionally lax: ops-api accepts any
// non-empty string and lets Cloudflare backend.admissionLease() reject
// unknown strategies upstream. This avoids ops-api drift when
// core's Strategy union grows (contract expects it to).

const base64urlEncode = (str: string): string => {
  const utf8 = new TextEncoder().encode(str);
  let binary = "";
  for (const byte of utf8) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const base64urlDecode = (input: string): string => {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  const binary = atob(padded + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
};

export const encodeAttemptKey = (key: AttemptKey): string => base64urlEncode(JSON.stringify(key));

export type DecodeResult =
  | { readonly ok: true; readonly key: AttemptKey }
  | { readonly ok: false; readonly reason: string };

const isString = (v: unknown): v is string => typeof v === "string";

export const decodeAttemptKey = (encoded: string): DecodeResult => {
  let json: string;
  try {
    json = base64urlDecode(encoded);
  } catch {
    return { ok: false, reason: "malformed_base64url" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, reason: "malformed_json" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "not_object" };
  }
  const obj = parsed as Record<string, unknown>;
  if (!isString(obj.routeFingerprint)) {
    return { ok: false, reason: "missing_routeFingerprint" };
  }
  if (!isString(obj.schemaFingerprint)) {
    return { ok: false, reason: "missing_schemaFingerprint" };
  }
  if (!isString(obj.strategy) || obj.strategy.length === 0) {
    return { ok: false, reason: "invalid_strategy" };
  }
  if (!isString(obj.providerOutputAdapterVersion)) {
    return { ok: false, reason: "missing_providerOutputAdapterVersion" };
  }
  if (!isString(obj.transportAdapterVersion)) {
    return { ok: false, reason: "missing_transportAdapterVersion" };
  }
  return {
    ok: true,
    key: {
      routeFingerprint: obj.routeFingerprint,
      schemaFingerprint: obj.schemaFingerprint,
      strategy: obj.strategy as AttemptKey["strategy"],
      providerOutputAdapterVersion: obj.providerOutputAdapterVersion,
      transportAdapterVersion: obj.transportAdapterVersion,
    },
  };
};
