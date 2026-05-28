# agentOS

agentOS is a TypeScript substrate for agent runtimes that need durable effect
boundaries. It gives an agent a ledger, claim settlement, material resolution,
tool admission, and package boundary contracts without making app policy part
of the substrate.

The core rule is simple:

```text
ledger = durable truth
PreClaim = intended effect identity
MaterialRef = execution means
Cleanup/proof refs = release and verification vocabulary
projections = derived views
```

## What It Owns

- `@agent-os/core`: Durable Object base, ledger, submit loop, effect claims,
  material refs, tools, quotas, dispatch, extension capabilities, context
  packing, and `BoundaryContract`.
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

| Package                                  | Role                                                                |
| ---------------------------------------- | ------------------------------------------------------------------- |
| `@agent-os/core`                         | substrate, ledger, claims, tools, material refs, boundary contracts |
| `@agent-os/cloudflare-resource`          | Cloudflare D1/KV/R2/Queue/Workflow resource carrier                 |
| `@agent-os/workspace-session`            | provider-neutral workspace/session lifecycle facts                  |
| `@agent-os/workspace-session-cloudflare` | Cloudflare Sandbox-compatible workspace backend                     |
| `@agent-os/tenant-material`              | encrypted tenant credential records to `RefResolver.material`       |
| `@agent-os/llm-transport-http`           | HTTP LLM streaming into non-durable turn frames                     |
| `@agent-os/turn-stream`                  | token/progress frame algebra                                        |
| `@agent-os/run-stream`                   | submit/ledger/turn-frame composition                                |
| `@agent-os/decision-gate`                | durable decision gate events, projection, and admitter              |
| `@agent-os/skill-registry`               | install-time skill manifest to core tools                           |

See [docs/runtime-packages.md](docs/runtime-packages.md) for the full package
surface.

## Minimal Use

1. Extend `AgentDOBase`.
2. Register tools with `defineRegisteredTool`; do not bypass `ToolContract`.
3. Resolve endpoints, credentials, bindings, and external resources through
   `MaterialRef`.
4. Submit work through `submit`.
5. Read durable state from ledger events or derived projections.

```ts
import { AgentDOBase } from "@agent-os/core";
import { defineRegisteredTool } from "@agent-os/core/tools";

const lookup = defineRegisteredTool({
  definition: {
    type: "function",
    function: {
      name: "lookup",
      description: "Look up a symbolic key.",
      parameters: {
        type: "object",
        properties: { key: { type: "string" } },
        required: ["key"],
      },
    },
  },
  authorityClass: "read",
  admit: async () => ({ ok: true }),
  execute: async (args: { key: string }) => ({ value: args.key }),
});

export class AgentDO extends AgentDOBase<Env> {
  protected provideRefResolver() {
    return {
      material: (ref) => {
        if (ref.kind === "endpoint" && ref.ref === "llm") return this.env.LLM_ENDPOINT;
        if (ref.kind === "credential" && ref.ref === "llm-key") return this.env.LLM_KEY;
        return null;
      },
    };
  }
}
```

## Documents

- [Core Model](docs/core.md)
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
