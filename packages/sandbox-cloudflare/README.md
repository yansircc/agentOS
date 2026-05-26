# @agent-os/sandbox-cloudflare

Cloudflare Sandbox SDK-compatible backend for `@agent-os/sandbox`.

The package uses structural types instead of importing `@cloudflare/sandbox`;
apps provide the actual sandbox client from their Worker environment.

This package does not create durable sandbox sessions. Backend reuse is an
implementation detail and must not become application state.

