# @agent-os/client-react

## Purpose

React reactivity bridge over the framework-neutral `@agent-os/client` store.

## Invariant

React bindings adapt the client store only. They do not map AG-UI frames, decode
runtime events, choose transports, define component source, or invent local UI
read-model vocabulary.

## Minimal Usage

```ts
import { useClientStore } from "@agent-os/client-react";

const status = useClientStore(agent.store, (snapshot) => snapshot.status);
```

Named hooks are selectors over `@agent-os/client` state. Product components own
the pixels.

## Verification

```sh
cd packages/client/react
vp test run
```
