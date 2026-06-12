# @agent-os/ag-ui

## Purpose

Framework-neutral AG-UI wire projection for typed agentOS runtime events and
AgentSchema tool declarations.

## Invariant

AG-UI frames are edge protocol projections. They never write ledger facts,
replace agentOS tool algebra, or become runtime source truth.

## Minimal Usage

Decode AG-UI run input at unknown boundaries with the package-owned Effect
Schema:

```ts
import { AgUiRunAgentInputSchema, decodeAgUiRunAgentInput } from "@agent-os/ag-ui";
```

Project committed ledger events into AG-UI frames or cursor-preserving
envelopes after runtime payloads decode:

```ts
import { projectLedgerEventsToAgUiFrames, decodeLedgerEventToAgUiEnvelope } from "@agent-os/ag-ui";
```

Extension event details must enter AG-UI through `safeExtensionPayload` field
allowlists. The custom extension mapper receives only `AgUiSafeLedgerEvent`
metadata plus that browser-safe projected payload; it does not receive raw
ledger payloads.

Use `projectToolToAgUiTool` to expose AG-UI tool declarations generated from
`AgentSchema.projections.agUi`.

Use `projectAgUiFramesToActivities` for a neutral activity feed. React and
Svelte adapters consume that projection without parsing ledger payloads.

## Verification

```sh
cd packages/wire-adapters/ag-ui
vp test run
```
