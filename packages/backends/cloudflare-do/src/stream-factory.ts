import { Effect } from "effect";
import { TriggerFactoryError } from "@agent-os/kernel/errors";
import type { AnyAttachedStreamHandler } from "@agent-os/runtime";

export interface CloudflareAttachedStreamFactoryContext<Env> {
  readonly env: Env;
  readonly scope: string;
  readonly sql: SqlStorage;
}

export type CloudflareAttachedStreamFactory<Env> = (
  ctx: CloudflareAttachedStreamFactoryContext<Env>,
) => ReadonlyArray<AnyAttachedStreamHandler>;

export type CloudflareAttachedStreamSource<Env> =
  | ReadonlyArray<AnyAttachedStreamHandler>
  | CloudflareAttachedStreamFactory<Env>;

export const resolveCloudflareAttachedStreamSource = <Env>(
  source: CloudflareAttachedStreamSource<Env>,
  ctx: CloudflareAttachedStreamFactoryContext<Env>,
): Effect.Effect<ReadonlyArray<AnyAttachedStreamHandler>, TriggerFactoryError> =>
  typeof source !== "function"
    ? Effect.succeed(source)
    : Effect.try({
        try: () => source(ctx),
        catch: (cause) => new TriggerFactoryError({ scope: ctx.scope, cause }),
      });
