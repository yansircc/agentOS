import type { DispatchToScopeResult, DispatchToScopeSpec } from "@agent-os/core/types";
import type { SubmitResult, SubmitRunInput } from "@agent-os/core/runtime-protocol";

const CHANNEL_METHODS = new Set(["DELETE", "GET", "PATCH", "POST", "PUT"]);

export type ChannelMethod = "DELETE" | "GET" | "PATCH" | "POST" | "PUT";

export type ChannelPrincipal = Readonly<{
  authority: string;
  subject: string;
  claims?: Readonly<Record<string, unknown>>;
}>;

export type ChannelRequest = Readonly<{
  method: ChannelMethod;
  path: string;
  params: Readonly<Record<string, string>>;
  request: Request;
  url: URL;
}>;

export type ChannelSubmit = (input: SubmitRunInput) => Promise<SubmitResult>;

export type ChannelDispatch = (spec: DispatchToScopeSpec) => Promise<DispatchToScopeResult>;

export type ChannelRuntime = Readonly<{
  submit: ChannelSubmit;
  dispatch: ChannelDispatch;
}>;

export type ChannelContext = Readonly<
  ChannelRuntime & {
    principal: ChannelPrincipal;
  }
>;

export type ChannelVerifier = (
  request: ChannelRequest,
) => ChannelPrincipal | Promise<ChannelPrincipal>;

export type ChannelHandler<TResult = Response> = (
  request: ChannelRequest,
  context: ChannelContext,
) => TResult | Promise<TResult>;

export type ChannelRoute<
  TMethod extends ChannelMethod = ChannelMethod,
  TResult = Response,
> = Readonly<{
  method: TMethod;
  path: string;
  handler: ChannelHandler<TResult>;
}>;

export type DefinedChannel<TRoutes extends readonly ChannelRoute[] = readonly ChannelRoute[]> =
  Readonly<{
    verify: ChannelVerifier;
    routes: TRoutes;
  }>;

export const defineChannel = <const TRoutes extends readonly ChannelRoute[]>(spec: {
  readonly verify: ChannelVerifier;
  readonly routes: TRoutes;
}): DefinedChannel<TRoutes> => {
  if (typeof spec.verify !== "function") {
    throw new TypeError("defineChannel requires a verifier");
  }
  if (spec.routes.length === 0) {
    throw new TypeError("defineChannel requires at least one route");
  }

  const routes = spec.routes.map((route) => normalizeRoute(route)) as unknown as TRoutes;
  return Object.freeze({
    verify: spec.verify,
    routes: Object.freeze(routes),
  });
};

export const createChannelContext = (
  runtime: ChannelRuntime,
  principal: ChannelPrincipal,
): ChannelContext => {
  assertChannelRuntime(runtime);
  const verifiedPrincipal = normalizePrincipal(principal);
  return Object.freeze({
    principal: verifiedPrincipal,
    submit: runtime.submit,
    dispatch: runtime.dispatch,
  });
};

export const get = <TResult = Response>(
  path: string,
  handler: ChannelHandler<TResult>,
): ChannelRoute<"GET", TResult> => defineRoute("GET", path, handler);

export const post = <TResult = Response>(
  path: string,
  handler: ChannelHandler<TResult>,
): ChannelRoute<"POST", TResult> => defineRoute("POST", path, handler);

export const put = <TResult = Response>(
  path: string,
  handler: ChannelHandler<TResult>,
): ChannelRoute<"PUT", TResult> => defineRoute("PUT", path, handler);

export const patch = <TResult = Response>(
  path: string,
  handler: ChannelHandler<TResult>,
): ChannelRoute<"PATCH", TResult> => defineRoute("PATCH", path, handler);

export const del = <TResult = Response>(
  path: string,
  handler: ChannelHandler<TResult>,
): ChannelRoute<"DELETE", TResult> => defineRoute("DELETE", path, handler);

const defineRoute = <TMethod extends ChannelMethod, TResult = Response>(
  method: TMethod,
  path: string,
  handler: ChannelHandler<TResult>,
): ChannelRoute<TMethod, TResult> => normalizeRoute({ method, path, handler });

const normalizeRoute = <TMethod extends ChannelMethod, TResult = Response>(
  route: ChannelRoute<TMethod, TResult>,
): ChannelRoute<TMethod, TResult> => {
  if (!CHANNEL_METHODS.has(route.method)) {
    throw new TypeError(`Unsupported channel method: ${String(route.method)}`);
  }
  assertRoutePath(route.path);
  if (typeof route.handler !== "function") {
    throw new TypeError(`Channel route ${route.method} ${route.path} requires a handler`);
  }
  return Object.freeze({
    method: route.method,
    path: route.path,
    handler: route.handler,
  });
};

const assertRoutePath = (path: string): void => {
  if (typeof path !== "string" || path.length === 0) {
    throw new TypeError("Channel route path must be a non-empty string");
  }
  if (!path.startsWith("/")) {
    throw new TypeError(`Channel route path must start with "/": ${path}`);
  }
  if (path.includes("?") || path.includes("#")) {
    throw new TypeError(`Channel route path must not include query or hash: ${path}`);
  }
};

const assertChannelRuntime = (runtime: ChannelRuntime): void => {
  if (!isRecord(runtime)) {
    throw new TypeError("Channel runtime must be an object");
  }
  if (typeof runtime.submit !== "function") {
    throw new TypeError("Channel runtime requires submit");
  }
  if (typeof runtime.dispatch !== "function") {
    throw new TypeError("Channel runtime requires dispatch");
  }
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const normalizePrincipal = (principal: ChannelPrincipal): ChannelPrincipal => {
  if (!isRecord(principal)) {
    throw new TypeError("Channel verifier must return a principal object");
  }
  if (!nonEmptyString(principal.authority)) {
    throw new TypeError("Channel principal requires authority");
  }
  if (!nonEmptyString(principal.subject)) {
    throw new TypeError("Channel principal requires subject");
  }
  if (principal.claims !== undefined && !isRecord(principal.claims)) {
    throw new TypeError("Channel principal claims must be an object");
  }
  return Object.freeze({
    authority: principal.authority,
    subject: principal.subject,
    ...(principal.claims === undefined ? {} : { claims: Object.freeze({ ...principal.claims }) }),
  });
};
