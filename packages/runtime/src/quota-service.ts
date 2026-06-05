import { Context, Effect } from "effect";
import type { JsonStringifyError, SqlError } from "@agent-os/kernel/errors";
import type { LedgerTruthIdentity } from "./ledger";

export interface GrantResult {
  readonly granted: boolean;
  readonly consumed: number;
  readonly limit: number;
}

export class Quota extends Context.Tag("@agent-os/Quota")<
  Quota,
  {
    readonly tryGrant: (
      identity: LedgerTruthIdentity,
      key: string,
      amount: number,
      windowMs: number,
      limit: number,
      toolName: string,
      operationRef: string,
    ) => Effect.Effect<GrantResult, SqlError | JsonStringifyError>;
  }
>() {}
