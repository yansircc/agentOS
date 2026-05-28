# @agent-os/tenant-material

## Purpose

Adapter from encrypted tenant credential records to core `RefResolver`
material.

## Public API Status

Internal-stable, public-experimental. Experimental exports are listed in
`PUBLIC_API.md`.

## Invariant

Resolved credential material exists only as the return value of
`resolver.material(ref)`. Public summaries, rejections, ledger payloads,
projections, and stream frames remain symbolic.

## Minimal Usage

Use the package to resolve encrypted credential records at execution time.
Supply decrypt behavior explicitly; there is no plaintext passthrough or
ambient tenant/provider fallback.

## Verification

```sh
cd packages/tenant-material
vp test run
```
