# @agent-os/verification

## Purpose

Verification gate proof and projection carrier.

## Public API Status

Carrier package. Verification policy and quorum rules remain app-owned.

## Invariant

Verification facts are symbolic ledger proofs. The package does not perform
external validation by itself and does not store raw evidence bodies as durable
truth.

## Minimal Usage

Use verification events and projections to anchor observed proof refs after an
effect settles.

## Verification

```sh
cd packages/verification
vp test run
```
