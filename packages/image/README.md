# @agent-os/image

## Purpose

Optional image generation algebra, adapters, idempotency, settlement, and
projection helpers.

## Public API Status

Optional package. It is not part of a freeze surface.

## Invariant

Image generation effects settle through symbolic claim/proof state. Provider
credentials, raw provider responses, and generated binary assets stay outside
ledger-visible payloads unless reduced to explicit refs.

## Minimal Usage

Use the package when an app needs image-generation effect settlement without
putting provider vocabulary into core.

## Verification

```sh
cd packages/image
vp test run
```
