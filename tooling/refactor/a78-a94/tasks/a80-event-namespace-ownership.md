# a80: Event Namespace Ownership Gate + Resource Prefix Split

## Summary

stable axis: boundary contracts declare event namespace ownership.  
change axis: package event prefixes and repo enforcement tooling.  
invariant: no package writes ledger events under another package's owned prefix.

Current failure:

- `@agent-os/resource-carrier` owns `resource.`.
- Runtime/backend resource pool services also write `resource.granted`, `resource.reserved`, `resource.reserve_rejected`, `resource.consumed`, and `resource.released`.
- The resource carrier event definitions also produce confusing generated names like `resource.resource.provisioned`.
- Quota namespace is inconsistent: kernel declares both `dispatch.` and
  `quota.`, while quota writes currently use `dispatch.consumed` and
  `dispatch.rate_limited`.

## Key Changes

- Add the `event-namespaces` boundary rule in `docs/agent/boundary-rules.source.json`, implement its guard at `tooling/agentos-cli/src/check/check-event-namespaces.mjs`, and include it in `agentos check all`.
- The gate uses the TypeScript compiler API to collect owned prefixes from carrier/boundary declarations and literal event kinds passed to ledger writer APIs (`commit`, `tx.append`, `insertEvent`, `logLedgerEvent`, and backend-specific commit builders).
- The gate fails when a writer emits a literal event kind under an owned prefix unless that event kind is declared by that owner.
- Cleanly split concepts:
  - `resource.` remains carrier-owned external resource lifecycle vocabulary.
  - Runtime resource pool/accounting events move to `resource_pool.granted`, `resource_pool.reserved`, `resource_pool.reserve_rejected`, `resource_pool.consumed`, and `resource_pool.released`.
- Cleanly split quota concepts before enabling the namespace gate:
  - move quota events to `quota.consumed` and `quota.rate_limited`; or
  - record an explicit shared-prefix exception if `dispatch.*` is deliberately
    the quota writer.
  - Do not land the namespace gate while quota writes under `dispatch.*` by
    accident.
- Fix resource carrier event suffixes so generated full kinds are `resource.provisioned`, `resource.bound`, `resource.mutation.recorded`, `resource.destroyed`, and `resource.failed`.
- Update runtime resource/quota projectors, Cloudflare ResourcesLive/quota
  services, in-memory resources/quota services, backend protocol contract tests,
  docs, and generated API references.

## Tests

- Namespace gate fails on a fixture package that writes under another package's prefix.
- Namespace gate passes for declared carrier event kinds and for runtime `resource_pool.*`.
- Cloudflare and in-memory resource contract tests pass with `resource_pool.*`.
- Cloudflare and in-memory quota contract tests pass with `quota.*`, unless an
  explicit documented shared-prefix exception was chosen.
- Resource carrier reference docs no longer contain `resource.resource.*`.
- Grep gate:

```sh
git grep "resource\\.granted\\|resource\\.reserved\\|resource\\.reserve_rejected\\|resource\\.consumed\\|resource\\.released" -- packages docs
git grep "dispatch\\.consumed\\|dispatch\\.rate_limited" -- packages docs
```

must return zero.

## Gates

Full root gates:

```sh
bun run docs:generate
bun run effect-manifests:generate
bun run check
bun run typecheck
bun run test
bun run check:runtime
bun run check:full
effect-skill-scan <worktree> --strict --json --profile
git diff --check
```

## Assumptions

- Breaking event-kind changes are allowed.
- Runtime resource pool accounting is not the same concept as external resource carrier lifecycle.
