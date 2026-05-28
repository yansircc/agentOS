# @agent-os/resource-carrier

## Purpose

Provider-neutral resource lifecycle carrier.

## Invariant

Resource ledger facts are not the resource data store. Payloads contain symbolic
`MaterialRef`, `proofRef`, `mutationRef`, and `fingerprint` values only; they
must not contain credentials, provider response bodies, account ids, database
ids, object bytes, queue bodies, workflow payloads, or live handles.

## Minimal Usage

Use resource carrier facts for lifecycle and mutation proofs. Provider-specific
execution material belongs in a provider package.

```ts
import { resourceBoundaryPackage } from "@agent-os/resource-carrier";
```

## Verification

```sh
cd packages/carriers/resource
vp test run
```
