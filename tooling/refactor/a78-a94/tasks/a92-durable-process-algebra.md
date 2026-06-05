# a92: Durable Process Algebra

## Summary

stable axis: ledger facts are durable truth; due work, outbox, checkpoints, and
stream frames are mechanical buffers or projections.  
change axis: higher-order process/workflow authoring syntax and backend
execution details.  
invariant: durable process state is a rebuildable ledger projection; external
effects happen only behind idempotent acquire/step boundaries.

This task borrows algebra from Temporal, DBOS, Inngest, LangGraph, and Microsoft
Agent Framework. It does not adopt their runtime histories, checkpoint tables,
workflow memory, or service state as agentOS truth.

## Key Changes

- Add `docs/concepts/durable-process-algebra.md` defining:
  - `processRef`;
  - `intentEventId`;
  - `dueWorkId`;
  - `stepRef`;
  - command / awaitable vocabulary;
  - wait / resume vocabulary;
  - cancellation and redrive vocabulary;
  - terminal states: completed, cancelled, failed, rejected;
  - projection rebuild rule: process state is a fold over ledger facts.
- Expand `docs/guides/add-durable-trigger.md` with durable process rules:
  - deterministic commit path;
  - idempotent acquire/step boundary;
  - no external effects inside trigger transaction callbacks;
  - provider idempotency keys for external effects;
  - cancellation race semantics;
  - redrive semantics;
  - due work deletion never erases audit state.
- Add an external terminology glossary:
  - Temporal Workflow -> durable process instance;
  - Temporal Activity / DBOS Step -> acquire or step boundary;
  - LangGraph thread -> process cursor;
  - LangGraph checkpoint -> ledger cursor or projection snapshot;
  - Microsoft Agent Framework executor -> app node;
  - Microsoft Agent Framework edge -> command routing.
- Extend backend protocol lifecycle contracts where the current substrate already
  has the required primitives:
  - waiting/resume;
  - failed/rejected terminal;
  - deterministic fan-out/fan-in barrier;
  - pending-write preservation;
  - projection rebuild equality;
  - due_work deletion does not erase audit state.
- Do not add an arbitrary workflow-code replay engine. Replay ledger facts and
  projection folds, not arbitrary TypeScript / Effect process code.
- Do not merge batch and stream substrates. Stream persistence remains deferred
  until reconnect/resume product pressure requires durable stream logs.

## Tests

- A process projection rebuilt from ledger facts equals the live projection after
  scheduling, acquire, wait, resume, cancellation, redrive, and terminal paths.
- External effect retry cannot duplicate terminal facts for the same step.
- A cancellation racing with acquire produces exactly one legal terminal state.
- Fan-out/fan-in barrier resumes only after all required symbolic step refs are
  terminal.
- Failed/rejected terminal states cannot be resumed unless a new intent fact is
  appended.
- Deleting due_work rows or dispatch_outbox rows cannot delete audit-visible
  process state.

## Gates

Full root gates. `check:runtime` is mandatory when backend protocol contracts or
Durable Object behavior change.

Run focused grep gates proving no workflow/checkpoint table becomes source
truth:

```sh
git grep "checkpoint\\|workflow_state\\|process_state" packages docs
```

Any hit must be either a projection, a docs glossary mapping, or an explicit
deferred external reference.

## Assumptions

- This task may land as documentation + protocol contract tests before a new
  authoring DSL exists.
- A graph/workflow DSL is allowed only if it compiles to ledger intent,
  command/awaitable, acquire/step, wait/resume, and terminal facts.
- LangGraph, Temporal, DBOS, Inngest, and Microsoft Agent Framework remain
  references, not runtime dependencies.
