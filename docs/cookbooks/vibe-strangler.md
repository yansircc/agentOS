# Vibe Strangler

This cookbook records the migration shape for a browser coding harness such as
`vibe-coding-web`. It is not a product spec for vibe.

## Generator

Every part lands in exactly one set:

```text
substrate  agentOS ledger/submit/event/resource algebra
carrier    external execution or provider state root
app        tenant/auth/UI/product policy
```

The migration is a partition, not a percentage estimate.

## Partition

### substrate

Move to `AgentDOBase`:

- agent loop via `submit`;
- run facts via ledger events and `runTrace` / `runStatus`;
- live progress via `streamEvents`;
- app facts via `emitEvent`;
- delayed timeouts via `scheduleEvent`;
- quota/resource accounting via core projections.

Approval remains app-composed. Core provides the event/time/react pieces; vibe
owns the approval vocabulary, roles, nesting policy, and auto-advance UI rule.

### carrier

Use or extract carriers:

- `@agent-os/dynamic-worker` for stateless Worker-compatible generated code;
- `@agent-os/sandbox` only for Linux/process/filesystem/build/test work;
- `@agent-os/git-carrier` for Git proof/projection facts;
- `@agent-os/deploy-cloudflare` for preview/promote/readback/rollback proofs;
- `@agent-os/staging-artifact` for staged refs and reap facts.

Keep these in vibe until a second pressure app proves the same shape:

- stateful per-session sandbox lifecycle;
- workspace-session backup/restore;
- preview port manager.

### app

Never move into agentOS:

- Better Auth and tenant membership;
- tenant model and Cloudflare credentials;
- Skills zip registry and materialization policy;
- Workbench UI and mental model;
- Cloudflare product capability catalogue;
- front-door decision policy.

## Minimal Migration

```text
POST /api/agent/message
  -> vibe front-door policy
  -> VibeAgentDO.emitEvent("vibe.message.received", ...)
  -> VibeAgentDO.submit(...)
  -> carrier tools return proof refs
  -> host app commits vibe.* saga facts
  -> UI consumes streamEvents() and projects chat/runtime views
```

`/api/runs/state` becomes a projection over ledger events. It must not keep a
second mutable run table.

## Carrier Selection

```text
Worker-compatible pure request       -> dynamic-worker
file tree / git / build / test       -> sandbox or workspace-session
preview service / background server  -> sandbox-stateful
deploy to Cloudflare                 -> deploy-cloudflare
stage inspectable artifact           -> staging-artifact
```

If generated code needs filesystem state, package install, a running dev
server, or backup/restore, it is not a Dynamic Worker job.

## Acceptance

- app-facing writes cannot forge registered package prefixes;
- `git.*`, `deploy.*`, and `staging.*` facts use `subjectRef`;
- approval handoff is projected from app facts, not `runStatus`;
- `streamEvents` is the only live wire for ledger facts;
- sandbox preview URLs are not final delivery artifacts;
- run state is derivable from ledger events after reload.
