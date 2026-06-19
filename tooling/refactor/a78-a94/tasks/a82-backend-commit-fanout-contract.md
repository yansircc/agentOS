# a82: Backend Commit/Fanout Contract

## Summary

stable axis: a committed ledger write is durable truth; bus/stream fanout is post-commit notification.  
change axis: in-memory commit staging and event bus failure handling.  
invariant: post-commit sink failure cannot make a committed write appear failed; backend commit semantics are shared across Cloudflare and in-memory.

Current failures:

- In-memory dispatch can mutate outbox row state before all validation/projection work is finalized.
- Cloudflare and in-memory post-commit `fireMany` can propagate sink errors back to the caller after commit.

## Key Changes

- Introduce a backend-neutral commit/fanout contract test suite shared by Cloudflare and in-memory.
- In-memory backend must stage rows/outbox/due-work/projection changes first, validate/reduce, then atomically publish staged state.
- In-memory dispatch commit must not mutate `deliveredEventId`, attempts, or error fields until the full commit has passed validation/projection.
- Event bus sink callbacks are diagnostic-only:
  - ledger commit resolves after durable commit;
  - sink exceptions are captured and reported to diagnostics/test hooks;
  - diagnostics sink is the only failure output for fanout failures;
  - sink exceptions do not roll back committed ledger state and do not reject the commit result.
- App event handlers may remain failure-bearing if they are part of explicit product handler semantics; raw stream/SSE sinks must not be.
- Keep Cloudflare transaction semantics: SQL commit/projection/side effects happen inside `transactionSync`; bus fires only after commit.
- Add the `transaction-sync` boundary rule in `docs/agent/boundary-rules.source.json` and implement its guard at `tooling/agentos-cli/src/check/check-transaction-sync-sync-only.mjs`:
  - fail on `transactionSync(async ...)`;
  - fail on returned thenables, `.then`, timers, and microtask scheduling inside
    transaction builders;
  - fail on async trigger commit callbacks.

## Tests

- Failure injection: in-memory dispatch delivery succeeds, then projection/validation fails; outbox remains pending/redrivable.
- Cloudflare and in-memory: reducer failure rolls back ledger/projection/outbox mechanical writes.
- Cloudflare and in-memory: stream sink throws; ledger commit still resolves and later ledger reads show committed rows.
- Fanout sink throws for direct ledger commit, trigger terminal commit, and quota
  grant; committed rows remain readable and diagnostics record the sink failure.
- Bus normal path still fires committed events once and in ledger id order.
- Contract suite proves both backends agree on commit result vs fanout diagnostics.
- Existing exactly-one terminal gates remain mandatory: concurrent drain, redrive,
  cancel propagation, and late/duplicate completion still commit at most one
  terminal.
- Simulated DO restart/hibernation rebuilds runTrace/runStatus/runs from ledger
  and redrives pending `due_work` without relying on in-memory maps.

## Gates

Full root gates. `check:runtime` is mandatory. Add the transaction-sync
sync-only guard to `agentos check all`.

## Assumptions

- Sink failure is not a ledger failure. It is observability/fanout failure.
- No compatibility path for old in-memory outbox mutation order.
