# agentOS

Minimum declarative agent substrate on Cloudflare.

> Goal: let N dev projects skip reinventing agent infrastructure.
> Build on CF Workers / Agents framework / AI Gateway / Workflows / Sandbox / DO.
> Surface = 4 algebra ops + declarative `submitAgent` + tiny middleware set.

## Invariants

```
INV-1   No business UI. Optional infrastructure observability UI.
INV-2   Serves the "agent reasoning closed loop" only.
INV-3   "Pre-grant + consume" → Quota. Reactive face = on/scheduleEvent/view.reflective.
INV-4   What CF ships, we don't rewrite. Thin unifying naming is allowed.
INV-5   State ownership + agent boundary are invariants.
INV-6   v1 supports CF AI only (env.AI.run + AI Gateway), no BYOK.
INV-7   Built on CF Agents framework (Agent base + Session API).
INV-8   No BYOK.
INV-9   sandbox / workspace / browser are stateful dispatch carriers, addressed by scope id.
INV-10  Serves agent modules only. Non-agent parts use plain CF Workers; collaborate via Service Bindings.
```

## Surface (frozen after N=4 repo derivation)

```
CORE (~400-500 lines TS):
  4 algebra ops:
    ingest(channel, payload) -> log
    dispatch(carrier, intent) -> effect + log
    log(event, scope) -> ledger
    project(view, source) -> readonly      ← source pluggable
    on(eventKind, handler)                 ← reactive
    scheduleEvent({ at, event, data })     ← reactive
  AgentDO + submitAgent
  Admin Query HTTP API (/__ops/api/*)
  Standard view library:
    view.agentRuns / view.currentBudget / view.currentQuotaState

CARRIER MIDDLEWARE (2):
  withQuota
  withStructuredOutput

EXTENSIONS (thin wrappers):
  @agent-os/cf-tools         (sandbox / workspace / browser)
  @agent-os/kb-autorag
  @agent-os/http-channel
  @agent-os/audit-export
  @agent-os/view-{hyperdrive,vectorize,analytics-engine}
  @agent-os/identity / envelope / approval-inbox / billing-*

OPS LAYER (opt-in):
  @agent-os/ops-api / ops-client / ops-react

CF used directly (zero wrapping):
  Workflows / AI Gateway / Sandbox SDK / Browser Run / Workspace
  Agents framework / Session API / DO / D1 / R2 / Queue / Cron / WfP
```

## Meta-rule (decision filter)

> Symmetric duals, sharp boundaries, conservative defaults, orthogonal composition.
> When duality vs minimalism conflicts: **duality wins at the algebra layer, minimalism wins at the feature layer.**

## Status

- [x] Surface frozen (4 repo dogfood validation: Insight Helper / WhatsApp CS / Img-Gen / zeroY2)
- [ ] Spike 1: end-to-end minimum loop (current)
- [ ] Spike 2: workflow + waitForEvent suspendable agent
- [ ] Spec 24: invariants & surface (after spike 1+2)
- [ ] First reference app: Insight Helper rewrite

## Spike order

```
spike-1  end-to-end minimum loop          ← current, single point penetration
spike-2  workflow + step.waitForEvent     ← validates suspendable agent
spike-3  sandbox carrier                  ← validates INV-9 stateful carrier
spike-4  anthropic-via-openai-compat      ← validates LLM carrier unified endpoint
spike-5  Session API compaction           ← validates INV-7 bet
spike-6  AutoRAG per-tenant cost/perf     ← validates KB abstraction
```

spike-3 through spike-6 are demand-triggered during first reference app, not pre-validated.
