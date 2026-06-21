import { Context, Effect } from "effect";
import type { JsonStringifyError } from "@agent-os/core/errors";
import type { GrantResult } from "@agent-os/core/backend-protocol";
import type { LedgerTruthIdentity } from "@agent-os/core/runtime-protocol";
import type { RuntimeStorageError } from "./ledger";

export class Quota extends Context.Service<
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
    ) => Effect.Effect<GrantResult, RuntimeStorageError | JsonStringifyError>;
  }
>()("@agent-os/Quota") {}
