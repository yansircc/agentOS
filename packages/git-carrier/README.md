# @agent-os/git-carrier

## Purpose

Git workspace, commit, merge, revert, and cleanup proof carrier.

## Public API Status

Carrier package. It is not a provider SDK and does not own provider-specific
Git execution.

## Invariant

Git proofs are symbolic ledger facts. Repository handles, credentials, working
tree paths, and command output are execution material unless explicitly reduced
to a proof ref.

## Minimal Usage

Use the package vocabulary and projection to record Git proofs. Keep actual Git
execution in the carrier implementation or app-owned execution layer.

## Verification

```sh
cd packages/git-carrier
vp test run
```
