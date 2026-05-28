# @agent-os/sandbox

## Purpose

Provider-neutral bounded stateless sandbox tool algebra.

## Public API Status

Optional algebra package. It is not part of the core 1.0 freeze.

## Invariant

A sandbox run is bounded and stateless per call. The package does not own a
durable filesystem, background process, preview port, artifact store, or secret
injection model.

## Minimal Usage

Use the package to expose one bounded sandbox run as a normal agentOS tool.
Use workspace-session when the job needs stateful session semantics.

## Verification

```sh
cd packages/sandbox
vp test run
```
