# @agent-os/core (v0.1)

Minimum Effect-compliant agent-OS substrate for Cloudflare Workers.

> See `../../docs/spec-24-invariants-and-surface.md` for the full design.
> See `../../spikes/01-minimum-loop/` for vanilla-TS proof; this package is
> the Effect-compliant production rewrite of that loop.

## What's in v0.1

| Surface | Status |
|---|---|
| `AgentDOBase` — extendable DurableObject base | ✅ |
| `submitAgent` — declarative agent loop (LLM + tools) | ✅ |
| Ledger primitive (`log`, `events`) on DO SQLite | ✅ |
| LLM dispatch carrier (`env.AI.run`) | ✅ |
| `Tool<A, R>` interface (plain-Promise API) | ✅ |
| Standard `Data.TaggedError` vocabulary | ✅ (subset) |
| Boundary translation (Effect → Promise) | ✅ |
| `on(eventKind, handler)` reactive subscribe | ⏳ v0.2 |
| `scheduleEvent` delayed events | ⏳ v0.2 |
| `withQuota` middleware | ⏳ v0.2 |
| `withStructuredOutput` middleware | ⏳ v0.2 |
| `view.reflective.*` agent self-introspection | ⏳ v0.2 |
| view source plurality (Hyperdrive, AutoRAG, AE, …) | ⏳ v0.2+ |
| CF Agents framework integration (`extends Agent`) | ⏳ v0.2 |

## Effect compliance

Implementation follows `effect-ecosystem` skill rules EFF001-EFF032:
- `Effect.gen(function* () { yield* ... })` instead of `async/await`
- `Data.TaggedError` instead of `throw new Error`
- `Clock.currentTimeMillis` instead of `Date.now()`
- `Effect.try / Effect.tryPromise` instead of `try/catch`
- `Layer` + `ManagedRuntime` for dependency injection

The **public API** is plain TS Promise-typed; apps don't import Effect unless they want to.

## Usage

```ts
import { AgentDOBase, type AgentDOEnv, type Tool } from "@agent-os/core";

interface Env extends AgentDOEnv {
  AI: Ai;
  AGENT_DO: DurableObjectNamespace<AgentDO>;
}

const getCurrentTime: Tool<Record<string, never>, { iso: string }> = {
  definition: {
    type: "function",
    function: {
      name: "get_current_time",
      description: "Returns the current ISO timestamp.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  execute: () => Promise.resolve({ iso: new Date().toISOString() }),
};

export class AgentDO extends AgentDOBase<Env> {}

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    // ... call stub.submit({...}) — see examples/spike-01-effect for full example
  },
} satisfies ExportedHandler<Env>;
```
