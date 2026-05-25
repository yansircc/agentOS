# @agent-os/core (v0.2.7)

Minimum Effect-compliant agent-OS substrate for Cloudflare Workers.

> See `../../docs/spec-24-invariants-and-surface.md` for the full design.
> See `../../spikes/01-minimum-loop/` for vanilla-TS proof; this package is
> the Effect-compliant production rewrite of that loop.

## Public surface

| Surface | Status |
|---|---|
| `AgentDOBase` — extendable DurableObject base | ✅ |
| `submit(spec)` — declarative agent loop (LLM + tools) | ✅ |
| `events()` — query ledger for this DO's scope | ✅ |
| `on(kind, handler)` reactive subscribe (composable) | ✅ (v0.2.1) |
| `off(kind, handler)` reactive unsubscribe | ✅ (v0.2.1) |
| `scheduleEvent({ at, event, data })` delayed events | ✅ (v0.2.3) |
| `alarm()` DO alarm handler (auto-invoked by CF runtime) | ✅ (v0.2.3) |
| `withQuota(tool, spec)` rate-limit / budget middleware | ✅ (v0.2.7) |
| `withStructuredOutput` middleware | ⏳ deferred |
| `view.reflective.*` agent self-introspection | ⏳ v0.2 Phase 4 |
| view source plurality (Hyperdrive, AutoRAG, AE, …) | ⏳ v0.2+ |
| CF Agents framework integration (`extends Agent`) | ⏳ v0.2 Phase 4 |

## Boundary contract

```
AgentDOBase.submit(spec)  Promise:
  resolves -> SubmitResult { ok:true|false }       all logical aborts
  rejects  -> SqlError | JsonStringifyError        irrecoverable infra failures
              | ScopeMissingError                  DO addressed via newUniqueId

AgentDOBase.events()      Promise:
  resolves -> LedgerEventRpc[]                     possibly empty (empty ledger)
  rejects  -> SqlError | ScopeMissingError         read failure vs empty: distinguished

AgentDOBase.scheduleEvent(spec)  Promise:
  resolves -> { id: number }                       inserted scheduled_events.id
  rejects  -> SqlError | JsonStringifyError | ScopeMissingError
```

**Scope is SSoT-owned by the DO instance** — derived from `this.ctx.id.name`.
Service Tags (Ledger / EventBus / Scheduler / AiBinding) and Layers are
**module-private**. There is no Effect escape hatch on the public surface.

**Scheduler exactly-once-by-construction:** `fireDue` pre-checks the pending
row inside `ctx.storage.transactionSync` BEFORE inserting any ledger row. If
guard false (already fired), the transaction commits zero writes. No duplicate
ledger events possible under at-least-once alarm retries.

## Effect compliance

Implementation follows `effect-ecosystem` skill rules:
- `Effect.gen(function* () { yield* ... })` instead of `async/await`
- `Data.TaggedError` instead of `throw new Error`
- `Clock.currentTimeMillis` instead of `Date.now()`
- `Effect.try / Effect.tryPromise` instead of `try/catch`
- `Layer` + `ManagedRuntime` for dependency injection

The **public API** is plain TS Promise-typed; apps don't import Effect.

## Usage

```ts
import {
  AgentDOBase,
  type AgentDOEnv,
  type LedgerEventRpc,
  type SubmitSpec,
  type Tool,
} from "@agent-os/core";

interface Env extends AgentDOEnv {
  AI: Ai;
  AGENT_DO: DurableObjectNamespace<AgentDO>;
}

const myTool: Tool<{ key: string }, { value: string }> = {
  definition: { /* OpenAI function tool spec */ },
  execute: async (args) => ({ value: `value for ${args.key}` }),
};

export class AgentDO extends AgentDOBase<Env> {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.on("agent.delivered", async (event) => {
      // reactive callback; bounded by 5s timeout
    });
  }
}

// Submit an agent run
const stub = env.AGENT_DO.get(env.AGENT_DO.idFromName(scope));
const result = await stub.submit({
  intent: "help the user with X",
  context: { /* ... */ },
  agent: { provider: "@cf", model: "openai/gpt-oss-120b" },
  tools: { lookup: myTool },
  budget: { tokens: 10_000, maxTurns: 5, toolRetries: 2 },
  deliver: { event: "agent.delivered" }, // scope is implicit
});

// Schedule a future event
await stub.scheduleEvent({
  at: Date.now() + 5_000,
  event: "follow_up",
  data: { ... },
});
```

See `../../examples/spike-01-effect/` for a runnable end-to-end example.

## Migration notes

### v0.2.3 → v0.2.4+

`scheduled_events` table no longer stores a `scope` column. `CREATE TABLE
IF NOT EXISTS` won't rewrite an existing table, so DO storage produced by
v0.2.3 has a `scope TEXT NOT NULL` column that conflicts with v0.2.4+
inserts. For local dev: delete `.wrangler/` to drop the old SQLite. For
production: explicit migration required (pre-1.0 data is disposable, so
this case is unlikely to arise).

