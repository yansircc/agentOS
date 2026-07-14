# agentOS

agentOS is a TypeScript substrate for agent runtimes that need durable effect
boundaries. It gives an agent a ledger, claim settlement, material resolution,
tool admission, and package boundary contracts without making app policy part
of the substrate.

<!-- agentos:generated release-posture:start -->

Current release posture: 0.6.x active development. PUBLIC_API.md files guard against accidental exports; they are not API or schema freezes.

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

- `@agent-os/core`: platform-free claim, material, tool, context, and
  `BoundaryContract` algebra.
- `@agent-os/runtime`: backend-neutral runtime ports and projection contracts.
- Runtime carrier modules: provider-neutral event vocabulary, claim settlement
  helpers, proof refs, and derived projections.
- Runtime adapter subpaths: live provider materialization that resolves
  symbolic refs at execution time.
- Client/runtime projection modules: non-durable streams and UI-facing wiring
  over ledger events, turn frames, and submit results.

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

| Package             | Role                                                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@agent-os/core`    | narrow durable substrate algebra at the root plus explicit owner subpaths for schemas, protocols, claims, projections, tools, and workspace vocabulary                          |
| `@agent-os/runtime` | seven backend-neutral runtime Service Tags at the root plus explicit lifecycle, projection, diagnostic, settlement, workspace, wire, host, provider, and testing owner subpaths |
| `@agent-os/client`  | transport-neutral agent client store, decoded runtime ledger stream adapter, typed command surface, product-shell composition helper, and optional framework subpath bridges    |
| `@agent-os/evals`   | eval authoring DSL, symbolic eval configuration, deterministic assertion declarations, and runner-facing case/context types for generated app behavior checks                   |
| `@agent-os/cli`     | closed product-intent compiler, explicit local or deployment target binder, developer command surface, structural checks, and distribution gates                                |

<!-- agentos:generated package-map:end -->

See [docs/runtime-packages.md](docs/runtime-packages.md) for the full package
surface.

## Minimal Use

Author pre-runtime intent as files, not runtime wiring:

```text
agent/
  instructions.md
  agent.json
.agentos/generated/           # ignored compiler projection
```

`agentos ask` and `agentos dev` bind that closed product intent to the local
host directly. Advanced builds use a separate explicit
`agentos.deployment.jsonc`; deployment, provider, workspace-host, transport,
and correlation facts never enter `agent/agent.json`. The generated surface
owns target wiring and the typed client; product code should not hand-write
backend `SubmitSpec`, Durable Object wiring, identity glue, or stream glue.

Start at the executable
[local Node quickstart](docs/guides/quickstart-node.md). The full
[generated-target authoring reference](docs/guides/build-natural-language-workspace-agent.md)
covers skills, channels, schedules, workflows, and deployment boundaries.

## Documents

- [Runtime Packages](docs/runtime-packages.md)
- [Usage Surfaces](docs/usage-surfaces.md)
- [Boundary Contract](docs/boundary-contract.md)
- [Start Here](docs/start-here.md)
- [Verification](docs/verification.md)

## Verification

```sh
pnpm run check
pnpm run typecheck
pnpm run test
rm -rf /tmp/agentos-effect-scan && mkdir -p /tmp/agentos-effect-scan
effect-skill-scan /Users/yansir/code/52/agentOS --strict --output gate-json --evidence /tmp/agentos-effect-scan
git diff --check
```

Use `effect-skill-scan /Users/yansir/code/52/agentOS --strict --output raw-json --profile`
only when you need the large raw scanner payload.
