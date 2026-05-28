import { Context, Effect } from "effect";
import type { JsonStringifyError, SqlError } from "@agent-os/kernel/errors";

export interface GrantResult {
  readonly granted: boolean;
  readonly consumed: number;
  readonly limit: number;
}

export class Quota extends Context.Tag("@agent-os/Quota")<
  Quota,
  {
    readonly tryGrant: (
      scope: string,
      key: string,
      amount: number,
      windowMs: number,
      limit: number,
      toolName: string,
    ) => Effect.Effect<GrantResult, SqlError | JsonStringifyError>;
  }
>() {}
