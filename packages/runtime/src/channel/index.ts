const CHANNEL_METHODS = new Set(["DELETE", "GET", "PATCH", "POST", "PUT"]);

export type ChannelMethod = "DELETE" | "GET" | "PATCH" | "POST" | "PUT";

export type ChannelRequest = Readonly<{
  method: ChannelMethod;
  path: string;
  params: Readonly<Record<string, string>>;
  request: Request;
  url: URL;
}>;

export type ChannelContext<TContext = unknown> = TContext;

export type ChannelHandler<TContext = unknown, TResult = Response> = (
  request: ChannelRequest,
  context: ChannelContext<TContext>,
) => TResult | Promise<TResult>;

export type ChannelRoute<
  TMethod extends ChannelMethod = ChannelMethod,
  TContext = unknown,
  TResult = Response,
> = Readonly<{
  method: TMethod;
  path: string;
  handler: ChannelHandler<TContext, TResult>;
}>;

export type DefinedChannel<TRoutes extends readonly ChannelRoute[] = readonly ChannelRoute[]> =
  Readonly<{
    routes: TRoutes;
  }>;

export const defineChannel = <const TRoutes extends readonly ChannelRoute[]>(spec: {
  readonly routes: TRoutes;
}): DefinedChannel<TRoutes> => {
  if (spec.routes.length === 0) {
    throw new TypeError("defineChannel requires at least one route");
  }

  const routes = spec.routes.map((route) => normalizeRoute(route)) as unknown as TRoutes;
  return Object.freeze({
    routes: Object.freeze(routes),
  });
};

export const get = <TContext = unknown, TResult = Response>(
  path: string,
  handler: ChannelHandler<TContext, TResult>,
): ChannelRoute<"GET", TContext, TResult> => defineRoute("GET", path, handler);

export const post = <TContext = unknown, TResult = Response>(
  path: string,
  handler: ChannelHandler<TContext, TResult>,
): ChannelRoute<"POST", TContext, TResult> => defineRoute("POST", path, handler);

export const put = <TContext = unknown, TResult = Response>(
  path: string,
  handler: ChannelHandler<TContext, TResult>,
): ChannelRoute<"PUT", TContext, TResult> => defineRoute("PUT", path, handler);

export const patch = <TContext = unknown, TResult = Response>(
  path: string,
  handler: ChannelHandler<TContext, TResult>,
): ChannelRoute<"PATCH", TContext, TResult> => defineRoute("PATCH", path, handler);

export const del = <TContext = unknown, TResult = Response>(
  path: string,
  handler: ChannelHandler<TContext, TResult>,
): ChannelRoute<"DELETE", TContext, TResult> => defineRoute("DELETE", path, handler);

const defineRoute = <
  TMethod extends ChannelMethod,
  TContext = unknown,
  TResult = Response,
>(
  method: TMethod,
  path: string,
  handler: ChannelHandler<TContext, TResult>,
): ChannelRoute<TMethod, TContext, TResult> => normalizeRoute({ method, path, handler });

const normalizeRoute = <
  TMethod extends ChannelMethod,
  TContext = unknown,
  TResult = Response,
>(
  route: ChannelRoute<TMethod, TContext, TResult>,
): ChannelRoute<TMethod, TContext, TResult> => {
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
