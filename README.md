# agentOS

agentOS is a TypeScript substrate for agent runtimes that need durable effect
boundaries. It gives an agent a ledger, claim settlement, material resolution,
tool admission, and package boundary contracts without making app policy part
of the substrate.

<!-- agentos:generated release-posture:start -->

Current release posture: 0.5.x active development. PUBLIC_API.md files guard against accidental exports; they are not API or schema freezes.

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

| Package                                  | Role                                                                                                                                                                             |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@agent-os/kernel`                       | pure claim, boundary, material, projection, AgentSchema, JSON Schema dialect, tool, context, and type algebra                                                                    |
| `@agent-os/runtime`                      | Effect Tag runtime programs, runtime services, projections, workspace-job observability joins, and backend-neutral durable trigger authoring algebra                             |
| `@agent-os/runtime-protocol`             | runtime-owned serializable submit, admission, authored manifest, manifest projection, ledger identity, and runtime event vocabulary                                              |
| `@agent-os/telemetry-protocol`           | trace context and backend-neutral telemetry event tree vocabulary                                                                                                                |
| `@agent-os/telemetry-otlp`               | OTLP projection adapter for agentOS telemetry and ledger facts                                                                                                                   |
| `@agent-os/llm-protocol`                 | provider-neutral LLM request, response, route, and wire descriptor vocabulary                                                                                                    |
| `@agent-os/backend-protocol`             | storage-free backend port DTOs, protocol constants, intent-pointer payload parsers, retry policy, dispatch protocol, resource/quota projection shapes, and handler fanout policy |
| `@agent-os/backend-cloudflare-do`        | Cloudflare Durable Object backend, mount interpreter, and workspace-job host composition for agentOS runtime                                                                     |
| `@agent-os/backend-node-postgres`        | Node/Postgres production backend interpreter for backend-protocol schedule, dispatch, resource, quota, replay, and telemetry parity gates                                        |
| `@agent-os/resource-carrier`             | provider-neutral resource lifecycle facts, claims, settlement, and projection                                                                                                    |
| `@agent-os/resource-cloudflare`          | Cloudflare D1/KV/R2/Queue/Workflow/Worker resource materializer                                                                                                                  |
| `@agent-os/workspace-session`            | provider-neutral workspace/session lifecycle facts                                                                                                                               |
| `@agent-os/workspace-op`                 | provider-neutral workspace operation facts, settlement, and projection                                                                                                           |
| `@agent-os/workspace-op-local`           | local WorkspaceEnv executor for workspace operation request facts                                                                                                                |
| `@agent-os/workspace-session-cloudflare` | Cloudflare Sandbox-compatible workspace backend                                                                                                                                  |
| `@agent-os/workspace-env-cloudflare`     | Cloudflare Sandbox-compatible WorkspaceEnv adapter                                                                                                                               |
| `@agent-os/workspace-env-local`          | local host WorkspaceEnv adapter with explicit host execution domain                                                                                                              |
| `@agent-os/tenant-material`              | encrypted tenant credential records to execution-time material                                                                                                                   |
| `@agent-os/llm-transport-http`           | HTTP LLM streaming into non-durable turn frames                                                                                                                                  |
| `@agent-os/llm-transport-effect-ai`      | Effect AI provider projection adapter for the provider-neutral LlmTransport port                                                                                                 |
| `@agent-os/agent-authoring`              | filesystem-authored agent tree compiler to normalized AgentManifest Authored intent                                                                                              |
| `@agent-os/attached-stream`              | attached live stream frame algebra and transport codec                                                                                                                           |
| `@agent-os/turn-stream`                  | token/progress frame algebra                                                                                                                                                     |
| `@agent-os/workspace-env`                | workspace fs+exec actuator and standard workspace tool generator                                                                                                                 |
| `@agent-os/ag-ui`                        | AG-UI wire frame projection over runtime-protocol Recorded events and projections                                                                                                |
| `@agent-os/client`                       | transport-neutral agent client store and typed command surface                                                                                                                   |
| `@agent-os/client-react`                 | React bridge over @agent-os/client store                                                                                                                                         |
| `@agent-os/client-svelte`                | Svelte bridge over @agent-os/client store                                                                                                                                        |
| `@agent-os/run-stream`                   | submit/ledger/turn-frame composition                                                                                                                                             |
| `@agent-os/workspace-binding`            | workspace-env to runtime submit binding composer                                                                                                                                 |
| `@agent-os/sse-http`                     | Web Fetch SSE-over-HTTP response construction for agentOS stream codecs                                                                                                          |
| `@agent-os/decision-gate`                | durable decision gate events, projection, and admitter                                                                                                                           |
| `@agent-os/deploy-cloudflare`            | Cloudflare Worker deploy provider                                                                                                                                                |

<!-- agentos:generated package-map:end -->

See [docs/runtime-packages.md](docs/runtime-packages.md) for the full package
surface.

## Minimal Use

1. Author pre-runtime intent in one `agent/` tree.
2. Compile that tree into one normalized manifest plus provenance.
3. Mount the manifest through a backend adapter.
4. Use generated clients and projections instead of hand-writing backend
   submit specs.
5. Read durable state from ledger events or derived projections.

```ts
import { compileAgentTree } from "@agent-os/agent-authoring";

const compiled = compileAgentTree({
  files: [
    {
      path: "agent/instructions.md",
      kind: "markdown",
      text: "Answer with the current weather for the requested city.",
    },
    {
      path: "agent/tools/weather.ts",
      kind: "tool",
      declaration: { bindingRef: "tool.weather" },
    },
  ],
});

if (!compiled.ok) throw new Error(JSON.stringify(compiled.issues));

const { manifest, provenance } = compiled.value;
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
