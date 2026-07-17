# Ask A Workspace Agent Locally

This is the shortest supported agentOS path: author two product-intent files and
ask the agent one question. The local host owns target selection, transport,
session and turn correlation, workspace topology, and environment material.

## 1. Install

Create an empty directory, enter it, then run:

```agentos-command id=install
pnpm init
pnpm add @yansirplus/core @yansirplus/runtime @yansirplus/client @yansirplus/cli effect@4.0.0-beta.98 \
  --allow-build=esbuild \
  --allow-build=msgpackr-extract
```

## 2. Author The Agent

```agentos-file path=agent/instructions.md
You are a concise workspace assistant. Answer the user's request directly.
```

```agentos-file path=agent/agent.json
{
  "agentId": "local-workspace-agent",
  "kind": "workspace"
}
```

The marked file blocks are the canonical quickstart source. There is no second
local deployment configuration or target grammar.

## 3. Ask

The scripted LLM keeps this first proof deterministic and free of provider
credentials.

```agentos-command id=ask
pnpm exec agentos ask "Say hello" --llm test --llm-response "Hello from agentOS" --json
```

The delivered result contains `"final":"Hello from agentOS"`. Its `runId` and
`eventCount` are read-only lifecycle evidence derived from the runtime ledger;
first use does not require lifecycle configuration or raw command envelopes.

For skills, channels, schedules, workflows, Cloudflare targets, provider
material, generated clients, and ownership boundaries, continue with the
[generated-target authoring reference](build-natural-language-workspace-agent.md).
