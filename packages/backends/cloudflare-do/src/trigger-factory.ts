import { Effect } from "effect";
import { TriggerFactoryError } from "@agent-os/kernel/errors";
import type { AnyDurableTrigger } from "@agent-os/runtime";

export interface CloudflareTriggerFactoryContext<Env> {
  readonly env: Env;
  readonly scope: string;
  readonly sql: SqlStorage;
}

export type CloudflareTriggerFactory<Env> = (
  ctx: CloudflareTriggerFactoryContext<Env>,
) => ReadonlyArray<AnyDurableTrigger>;

export type CloudflareTriggerSource<Env> =
  | ReadonlyArray<AnyDurableTrigger>
  | CloudflareTriggerFactory<Env>;

export const resolveCloudflareTriggerSource = <Env>(
  source: CloudflareTriggerSource<Env>,
  ctx: CloudflareTriggerFactoryContext<Env>,
): Effect.Effect<ReadonlyArray<AnyDurableTrigger>, TriggerFactoryError> =>
  (typeof source !== "function"
    ? Effect.succeed(source)
    : Effect.try({
        try: () => source(ctx),
        catch: (cause) => new TriggerFactoryError({ scope: ctx.scope, cause }),
      })
  ).pipe(Effect.withSpan("agentos.cloudflare_do.trigger.resolve_source"));
