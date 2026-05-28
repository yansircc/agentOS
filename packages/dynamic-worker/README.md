# @agent-os/dynamic-worker

## Purpose

Provider-neutral Dynamic Worker carrier for bounded Worker-compatible code
execution.

## Public API Status

Optional runtime package. Public exports are package-owned and not part of the
core 1.0 freeze.

## Invariant

A dynamic worker run is one bounded stateless request. It is not a workspace,
does not own durable isolate identity, and does not write ledger truth by
itself.

## Minimal Usage

Use this package when generated code can run as a Worker-compatible function.
Use `@agent-os/workspace-session` when the job needs a filesystem, preview
ports, long-running services, backups, or cleanup roots.

## Verification

```sh
cd packages/dynamic-worker
vp test run
```
