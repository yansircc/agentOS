# Build A Cloud Agent App

## Goal

Build the smallest Cloudflare Durable Object app that consumes agentOS packages
and exposes an app facade.

## What You Build

A Cloudflare app with one `defineAgentDO` class, one tool, one LLM route, and
the standard verification gates.

## Prerequisites

- [Distribution boundary](../concepts/distribution-boundary.md)
- [Durable truth](../concepts/durable-truth.md)
- [Cloudflare DO backend](../packages/backend-cloudflare-do.md)

## Steps

1. Configure the internal npm registry.
2. Install `@agent-os/runtime`, `@agent-os/backend-cloudflare-do`, and `effect`.
3. Define a tool with `defineTool`.
4. Define a Durable Object with `defineAgentDO`.
5. Bind endpoint and credential material symbolically.
6. Run typecheck and package tests.

## Checkpoint

The app compiles without importing agentOS source workspaces or backend
internals.

## Next

Add background work with [durable triggers](../guides/add-durable-trigger.md)
or live sessions with [attached streams](../guides/add-attached-stream.md).
