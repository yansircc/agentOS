# @agent-os/staging-artifact

## Purpose

Staging artifact publication and reaping proof carrier.

## Invariant

Artifact bytes and provider storage handles stay outside ledger payloads. The
ledger records symbolic artifact and reaping proofs.

## Minimal Usage

Use package events and projections to anchor artifact facts. Store and read
artifact bytes through the provider data plane.

## Verification

```sh
cd packages/staging-artifact
vp test run
```
