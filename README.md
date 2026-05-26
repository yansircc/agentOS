# agentOS

Cloudflare Durable Object substrate for ledger-owned agent control flow.

The repo keeps durable decisions and production core code. Historical runnable
spikes are retired after their conclusions land in specs, tests, or cookbooks.

## Layout

```text
docs/
  specs/       frozen or active design records
  cookbooks/   pseudocode shapes derived from dogfood and spikes
  notes/       retained exploration notes that are not public surface

packages/
  core/        @agent-os/core implementation and contract tests

spikes/
  _active/     ignored local throwaway work only
```

## Core Surface

`AgentDOBase` is the public boundary. Apps extend it and use:

- ledger write/read: `emitEvent`, `events`, `streamEvents`
- reactive control: `on`, `off`, `scheduleEvent`, `alarm`
- agent loop: `submit`
- cross-scope delivery: `dispatchToScope`
- business resources: `grantResource`, `reserveResource`, `consumeResource`, `releaseResource`
- image generation: `generateImage`
- provider route injection: `provideRegistry`, `provideDispatchTargets`

The ledger is the source of truth. Schedules, dispatch outboxes, leases,
resource availability, and views are pending buffers or projections.

## Documents

- [Spec 24](docs/specs/spec-24-invariants-and-surface.md): invariants and public surface
- [Spec 25](docs/specs/spec-25-llm-admission.md): structured-output admission
- [Spec 27](docs/specs/spec-27-llm-protocol-adapter.md): protocol adapter algebra
- [Spec 28](docs/specs/spec-28-img-gen-gap-implementation-plan.md): img-gen gap implementation plan
- [Spec 29](docs/specs/spec-29-ledger-event-stream.md): ledger event stream

Cookbooks are not runnable examples. They are short app-shape records:

- [Reactive Interview](docs/cookbooks/reactive-interview.md)
- [Img-Gen Pipeline](docs/cookbooks/img-gen-pipeline.md)
- [Protocol Adapter Live-Wire Notes](docs/cookbooks/protocol-adapter-live-wire.md)
- [Approval Race](docs/cookbooks/approval-race.md)
- [Carrier Mutation](docs/cookbooks/carrier-mutation.md)
- [Parallel Dev MVP](docs/cookbooks/parallel-dev-mvp.md)
- [Parallel Agent Startup](docs/cookbooks/parallel-agent-startup.md)
- [Happy Project Batch](docs/cookbooks/happy-project-batch.md)

## Verification

```sh
bun run typecheck
cd packages/core && bun run test
git diff --check
```
