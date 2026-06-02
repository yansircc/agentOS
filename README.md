# agentOS

agentOS is a TypeScript substrate for agent runtimes that need durable effect
boundaries. It gives an agent a ledger, claim settlement, material resolution,
tool admission, and package boundary contracts without making app policy part
of the substrate.

<!-- agentos:generated release-posture:start -->

Current release posture: 0.2.x active development. PUBLIC_API.md files guard against accidental exports; they are not API or schema freezes.

<!-- agentos:generated release-posture:end -->

The core rule is simple:

```text
ledger = durable truth
PreClaim = intended effect identity
MaterialRef = execution means
Cleanup/proof refs = release and verification vocabulary
projections = derived views
```

## What It Owns

- `@agent-os/kernel`: platform-free claim, material, tool, context, and
  `BoundaryContract` algebra.
- `@agent-os/runtime`: backend-neutral runtime ports and projection contracts.
- Carrier packages: provider-neutral event vocabulary, claim settlement helpers,
  proof refs, and derived projections.
- Backend packages: live provider materialization that resolves symbolic refs at
  execution time.
- Composition packages: non-durable streams and UI-facing wiring over ledger
  events, turn frames, and submit results.

## What It Does Not Own

- Product approval policy.
- App scheduling policy.
- Product-specific context selection or summarization.
- Provider secrets, raw resource data, SQL, queue bodies, object bytes, or live
  SDK handles in ledger payloads.

Unsupported capability must fail closed. Do not add fallback behavior or shadow
state to make a product flow appear complete.

## Package Map

<!-- agentos:generated package-map:start -->

| Package                                  | Role                                                                                                                                |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `@agent-os/kernel`                       | pure claim, boundary, material, JSON Schema, tool, context, and type algebra                                                        |
| `@agent-os/runtime`                      | Effect Tag runtime programs, admission projections, runtime-facing API types, and backend-neutral durable trigger authoring algebra |
| `@agent-os/backend-protocol`             | storage-free backend protocol constants, intent-pointer payload parsers, retry policy, dispatch protocol, and handler fanout policy |
| `@agent-os/backend-cloudflare-do`        | Cloudflare Durable Object app facade and backend for agentOS runtime                                                                |
| `@agent-os/resource-carrier`             | provider-neutral resource lifecycle facts, claims, settlement, and projection                                                       |
| `@agent-os/resource-cloudflare`          | Cloudflare D1/KV/R2/Queue/Workflow/Worker resource materializer                                                                     |
| `@agent-os/workspace-session`            | provider-neutral workspace/session lifecycle facts                                                                                  |
| `@agent-os/workspace-session-cloudflare` | Cloudflare Sandbox-compatible workspace backend                                                                                     |
| `@agent-os/tenant-material`              | encrypted tenant credential records to execution-time material                                                                      |
| `@agent-os/llm-transport-http`           | HTTP LLM streaming into non-durable turn frames                                                                                     |
| `@agent-os/attached-stream`              | attached live stream frame algebra and transport codec                                                                              |
| `@agent-os/turn-stream`                  | token/progress frame algebra                                                                                                        |
| `@agent-os/run-stream`                   | submit/ledger/turn-frame composition                                                                                                |
| `@agent-os/decision-gate`                | durable decision gate events, projection, and admitter                                                                              |
| `@agent-os/skill-registry`               | install-time skill manifest to core tools                                                                                           |
| `@agent-os/deploy-cloudflare`            | Cloudflare Worker deploy provider                                                                                                   |

<!-- agentos:generated package-map:end -->

See [docs/runtime-packages.md](docs/runtime-packages.md) for the full package
surface.

## Minimal Use

1. Define tools from one Effect Schema.
2. Declare concrete endpoint, credential, binding, and resource material once
   in `bindings`.
3. Reference only symbolic material ids from routes and dispatch targets.
4. Configure `llms.default` to expose facade `submit`; event-only facades keep
   `emit`, `schedule`, and `dispatch` without a submit method.
5. Read durable state from ledger events or derived projections.

```ts
import { credential, defineAgentDO, endpoint, openAIChat } from "@agent-os/backend-cloudflare-do";
import { defineTool } from "@agent-os/kernel/tools";
import { Schema } from "effect";

const lookup = defineTool({
  name: "lookup",
  description: "Look up a symbolic key.",
  args: Schema.Struct({ key: Schema.String }),
  authority: "read",
  admit: "allow",
  execute: ({ key }) => ({ value: key }),
});

export const AgentDO = defineAgentDO<Env>({
  bindings: [
    endpoint("llm").from((env) => env.LLM_ENDPOINT),
    credential("llm-key").from((env) => env.LLM_KEY),
  ],
  llms: {
    default: openAIChat({
      model: "gpt-4.1-mini",
      endpoint: "llm",
      credential: "llm-key",
    }),
  },
  tools: [lookup],
  on: {
    "interview.answer": ({ data, agent }) => {
      return agent.emit("interview.answer.recorded", data);
    },
  },
});
```

## Documents

- [Runtime Packages](docs/runtime-packages.md)
- [Usage Surfaces](docs/usage-surfaces.md)
- [Boundary Contract](docs/boundary-contract.md)
- [Runtime Packages](docs/runtime-packages.md)
- [Verification](docs/verification.md)

## Verification

```sh
bun run check
bun run typecheck
bun run test
effect-skill-scan /Users/yansir/code/52/agentOS --strict --json --profile
git diff --check
```
