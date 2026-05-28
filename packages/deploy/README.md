# @agent-os/deploy

## Purpose

Provider-neutral deploy proof and projection carrier.

## Public API Status

Carrier package. Provider-specific deploy backends are separate materializers.

## Invariant

Deploy facts record symbolic preview, promotion, readback, and rollback proofs.
Provider response bodies and live handles stay outside ledger payloads.

## Minimal Usage

Use deploy events and settlement helpers to anchor deployment facts. Keep
provider API calls in a backend package or app-owned execution layer.

## Verification

```sh
cd packages/deploy
vp test run
```
