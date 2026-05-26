import type {
  ApiResult,
  NormalizedOpsHtmxOptions,
} from "./types";

const trimSlashes = (value: string): string => value.replace(/^\/+|\/+$/g, "");

export const joinPath = (base: string, tail: string): string => {
  const b = `/${trimSlashes(base)}`;
  const t = trimSlashes(tail);
  return t.length === 0 ? b : `${b}/${t}`;
};

export const uiPath = (
  opts: Pick<NormalizedOpsHtmxOptions, "uiBase">,
  tail: string,
  params: Readonly<Record<string, string | number | undefined>> = {},
): string => {
  const path = joinPath(opts.uiBase, tail);
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const qs = search.toString();
  return qs.length === 0 ? path : `${path}?${qs}`;
};

export const apiGetJson = async <T>(
  opts: Pick<NormalizedOpsHtmxOptions, "apiBase" | "apiFetch">,
  sourceReq: Request,
  tail: string,
  params: Readonly<Record<string, string | number | undefined>> = {},
): Promise<ApiResult<T>> => {
  const sourceUrl = new URL(sourceReq.url);
  sourceUrl.pathname = joinPath(opts.apiBase, tail);
  sourceUrl.search = "";
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) sourceUrl.searchParams.set(key, String(value));
  }

  const headers = new Headers(sourceReq.headers);
  headers.set("accept", "application/json");

  const response = await opts.apiFetch(
    new Request(sourceUrl.toString(), {
      method: "GET",
      headers,
    }),
  );
  const text = await response.text();
  const parsed: unknown = text.length === 0 ? null : JSON.parse(text);

  if (response.ok) {
    return { ok: true, status: response.status, value: parsed as T };
  }

  const body =
    parsed !== null &&
    typeof parsed === "object" &&
    "error" in parsed &&
    "message" in parsed
      ? (parsed as { readonly error: string; readonly message: string })
      : {
          error: `http_${response.status}`,
          message: text.length > 0 ? text : response.statusText,
        };

  return { ok: false, status: response.status, error: body };
};

export const encodedScopeTail = (scope: string, tail = ""): string => {
  const encoded = encodeURIComponent(scope);
  return tail.length === 0 ? `scopes/${encoded}` : `scopes/${encoded}/${tail}`;
};
