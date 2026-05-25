# @agent-os/core (v0.2.1)

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
| Ledger primitive (`log`, `events`) on DO SQLite | ✅ |
| LLM dispatch carrier (`env.AI.run`) | ✅ |
| `Tool<A, R>` interface (plain-Promise API) | ✅ |
| Standard `Data.TaggedError` vocabulary | ✅ (subset) |
| `on(kind, handler)` reactive subscribe (composable) | ✅ (v0.2.1) |
| `off(kind, handler)` reactive unsubscribe | ✅ (v0.2.1) |
| `scheduleEvent({ at, event, data })` delayed events | ⏳ v0.2 Phase 2 |
| `withQuota` middleware | ⏳ v0.2 Phase 3 |
| `withStructuredOutput` middleware | ⏳ v0.2 Phase 3 |
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
```

**Scope is SSoT-owned by the DO instance.** `SubmitSpec.deliver.scope` does not
exist; the scope is derived from `this.ctx.id.name` (the name supplied to
`idFromName`). DOs created via `newUniqueId` reject all calls with
`ScopeMissingError`.

## Effect compliance

Implementation follows `effect-ecosystem` skill rules (EFF001-EFF032):
- `Effect.gen(function* () { yield* ... })` instead of `async/await`
- `Data.TaggedError` instead of `throw new Error`
- `Clock.currentTimeMillis` instead of `Date.now()`
- `Effect.try / Effect.tryPromise` instead of `try/catch`
- `Layer` + `ManagedRuntime` for dependency injection

The **public API** is plain TS Promise-typed; apps don't import Effect unless
they want to. There is no Effect escape hatch on the public surface — internal
`submitAgentEffect` is module-private.

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
  definition: {
    type: "function",
    function: {
      name: "lookup",
      description: "Lookup a value by key.",
      parameters: {
        type: "object",
        properties: { key: { type: "string" } },
        required: ["key"],
      },
    },
  },
  execute: async (args) => ({ value: `value for ${args.key}` }),
};

export class AgentDO extends AgentDOBase<Env> {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    // Reactive subscribe — fires when ledger.log writes "agent.delivered"
    this.on("agent.delivered", async (event) => {
      // handler logic; max 5s before timeout
    });
  }
}

// In your fetch handler:
const stub = env.AGENT_DO.get(env.AGENT_DO.idFromName(scope));
const result = await stub.submit({
  intent: "help the user with X",
  context: { /* ... */ },
  agent: { provider: "@cf", model: "openai/gpt-oss-120b" },
  tools: { lookup: myTool },
  budget: { tokens: 10_000, maxTurns: 5, toolRetries: 2 },
  deliver: { event: "agent.delivered" }, // scope is implicit
});
```

See `../../examples/spike-01-effect/` for a runnable end-to-end example.
