# @agent-os/client-svelte

## Purpose

Svelte reactivity bridge over the framework-neutral `@agent-os/client` store.

## Invariant

Svelte bindings adapt the client store only. They do not map AG-UI frames,
decode runtime events, choose transports, define component source, or invent
local UI read-model vocabulary.

## Minimal Usage

```ts
import { selectClientReadable } from "@agent-os/client-svelte";

const status = selectClientReadable(agent.store, (snapshot) => snapshot.status);
```

Readables are selectors over `@agent-os/client` state. Product components own
the pixels.

## Verification

```sh
cd packages/client/svelte
vp test run
```
