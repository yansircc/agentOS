export const escapeHtml = (value: unknown): string => {
  const input = String(value);
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
};

export const escapeAttr = escapeHtml;

const normalizeJsonValue = (
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
  depth = 0,
): unknown => {
  if (value === null) return null;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return "[unserializable]";
  if (seen.has(value)) return "[circular]";
  if (depth >= 8) return "[depth-limit]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeJsonValue(entry, seen, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = normalizeJsonValue(
      (value as Record<string, unknown>)[key],
      seen,
      depth + 1,
    );
  }
  return out;
};

export const compactJson = (value: unknown): string =>
  JSON.stringify(normalizeJsonValue(value)) ?? "null";

export const prettyJson = (value: unknown): string =>
  JSON.stringify(normalizeJsonValue(value), null, 2) ?? "null";

export const textResponse = (
  html: string,
  status = 200,
): Response =>
  new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });

export const methodNotAllowed = (): Response =>
  textResponse(
    '<div class="state state-error"><b>405</b><span>method_not_allowed</span></div>',
    405,
  );

export const notFound = (): Response =>
  textResponse(
    '<div class="state state-error"><b>404</b><span>not_found</span></div>',
    404,
  );
