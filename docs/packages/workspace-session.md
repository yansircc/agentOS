# @agent-os/workspace-session

## Purpose

Provider-neutral workspace/session lifecycle carrier.

## Invariant

`ScopeRef(kind: "session")` names the ownership class. Retention, preview,
backup, workspace root, and cleanup refs are payload metadata and proof refs,
not new scope kinds.

## Minimal Usage

Use the carrier to settle start, restore, backup, preview, destroy, and failure
facts. Use a backend package to obtain provider-specific refs.

## Verification

```sh
cd packages/workspace-session
vp test run
```
