# Run A Workspace Agent Locally

This is the shortest supported agentOS path: author three files, compile a
`workspace@1` agent to the generated `node@1` target, serve it with the scripted
test LLM, submit one session turn, and read its durable runtime facts.

## 1. Install

Create an empty directory, enter it, then run:

```agentos-command id=install
pnpm init
pnpm add @yansirplus/core @yansirplus/runtime @yansirplus/client @yansirplus/cli effect
```

## 2. Author The Agent

```agentos-file path=agent/instructions.md
You are a concise workspace assistant. Answer the user's request directly.
```

```agentos-file path=agent/agent.json
{
  "agentId": "local-workspace-agent",
  "scope": {
    "kind": "session",
    "idSource": "manifest",
    "stableScopeId": "local-workspace-agent"
  },
  "effectAuthorityRef": {
    "authorityClass": "effect",
    "authorityId": "local-workspace-agent"
  }
}
```

```agentos-file path=agentos.config.jsonc
{
  "profile": "workspace@1",
  "agent": "./agent",
  "deployment": {
    "id": "local-workspace-agent",
    "version": "0.1.0"
  },
  "target": { "kind": "node@1" },
  "client": { "kind": "browser-direct@1" },
  "llm": {
    "route": "openai-chat-compatible",
    "endpointRef": "openrouter",
    "credentialRef": "openrouter-key",
    "modelRef": "openrouter-default-text-model"
  },
  "workspace": {
    "binding": "Sandbox",
    "root": "/workspace"
  }
}
```

The file blocks above are executable documentation. The release gate
materializes these exact bytes; it does not maintain a second tutorial fixture.

## 3. Build

```agentos-command id=build
pnpm exec agentos build --cwd . --package-scope @yansirplus
```

The generated residual program is written under `.agentos/generated/`.

## 4. Serve

Run the local app in one terminal. The scripted LLM keeps this first proof free
of provider credentials.

```agentos-command id=serve
pnpm exec agentos serve --cwd . --port 8787 --llm test --llm-response "Hello from agentOS"
```

## 5. Submit One Turn

In another terminal:

```agentos-command id=submit
curl --fail-with-body http://127.0.0.1:8787/agentos/command \
  --header 'content-type: application/json' \
  --data '{"name":"submitSessionTurn","input":{"sessionRef":"quickstart","turnRef":"quickstart:turn-1","intent":"Say hello","context":{}}}'
```

The response contains `ok: true` and the scripted final answer.

## 6. Read The Runtime Projection

```agentos-command id=read_projection
curl --fail-with-body http://127.0.0.1:8787/agentos/events
```

The finite SSE snapshot contains ledger events ending in
`agent.run.completed` or `runtime.completed_after_tools`. Intermediate provider
material is never part of this projection.

For skills, channels, schedules, workflows, Cloudflare targets, provider
material, generated clients, and ownership boundaries, continue with the
[generated-target authoring reference](build-natural-language-workspace-agent.md).
