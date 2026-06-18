# @agent-os/agent-authoring

## Purpose

Composition package that compiles an authored `agent/` tree into one normalized
`AgentManifest<Authored>` plus provenance.

## Invariant

Agent-authoring is a pure projection over pre-runtime intent. It does not read
the filesystem, import tool modules, mount backends, create clients, resolve
materials, or write runtime ledger facts.

## Minimal Usage

Pass a resolved authored tree to `compileAgentTree` and consume either the
compiled manifest/provenance or the closed issue list.

```ts
import { compileAgentTree } from "@agent-os/agent-authoring";
```

Filesystem loading and backend mounting stay outside this package.

## Verification

```sh
cd packages/composers/agent-authoring
vp test run
```
