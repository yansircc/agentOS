# Consume npm Packages

## Outcome

An independent agent app can install agentOS through versioned npm packages
instead of sharing the agentOS source workspace lockfile.

## Prerequisites

- [Distribution boundary](../concepts/distribution-boundary.md)
- [npm distribution](../distribution.md)

## Steps

1. Install required packages with semver versions.
2. Use the published `@yansirplus/core`, `@yansirplus/runtime`,
   `@yansirplus/client`, and `@yansirplus/cli` package names.
3. Install required peers such as `effect`. Workspace-profile Cloudflare targets
   also need the generated target imports they use, including
   `@cloudflare/sandbox` and the selected runtime provider peers.
4. Build generated agent targets with the public package scope:
   `pnpm run agentos build --cwd /path/to/consumer --package-scope
@yansirplus`. This makes generated imports use the public `@yansirplus` scope
   instead of source workspace packages.
5. For prepublish first-party work, run `pnpm run install:consumer
/path/to/consumer` in agentOS. This overlays the generated final public package
   projection into the consumer `node_modules` without changing the consumer
   manifest or lockfile.
6. Inspect the overlay with `pnpm run status:consumer /path/to/consumer`.
   Use `pnpm run status:consumer -- /path/to/consumer --json` for a
   machine-readable report, or add `--check-npm` when the task needs an npm
   latest comparison.
7. Restore the consumer to registry truth with `pnpm run restore:consumer
/path/to/consumer`.
8. If the consumer must exercise registry or dist-tag behavior instead, run a
   local registry channel: `pnpm run registry:local`, then
   `pnpm run publish:local` in agentOS.
9. Read `dist/internal-npm/local-channel.json`.
10. Copy the required `dependencies` entries into the consumer app. Use the
    logical tag value, for example `agentos-dev`; do not copy worktree tarball
    paths. Configure `@yansirplus:registry` once in the consumer `.npmrc` only
    when consuming the local channel.
11. Run the app typecheck and tests under its own lockfile.

## Installed Agent Catalog

`@yansirplus/cli` carries one generated `agent-catalog/agentOS` bundle. Coding
agents should read `agent-catalog/agentOS/SKILL.md` first and treat it as a
router, then load only the needed files under `references/`:

- `references/package-map.md` for package ownership and entrypoints;
- `references/public-api/*.md` for public API intent;
- `references/agent/start-here.md` for the generated navigation route;
- `references/agent/*.json` for recipes, primitives, decisions, errors, and
  invariants;
- `references/provenance.json` for source and output hashes.

The catalog is installed-version truth, not a source authoring surface. Do not
hand-edit `agent-catalog/agentOS/*` or create `catalog.source.json`; edit the
owning package/docs facts and regenerate the catalog.

## Import Surface

Use direct package roots only for consumer-facing packages:

```ts
import { compileAgentTree } from "@yansirplus/cli";
import { createAgentClient } from "@yansirplus/client";
```

Generated agent targets emit their own runtime/core imports. Do not hand-write
these in ordinary app code; keep them inside generated target files:

```ts
import { bindWorkspaceToolsForRuntime } from "@yansirplus/runtime/workspace-binding";
import type { SubmitRunInput } from "@yansirplus/core/runtime-protocol";
import { deterministicToolExecution } from "@yansirplus/core/tools";
```

Backend or substrate authors may import explicit runtime adapter subpaths:

```ts
import { createAgentDurableObject } from "@yansirplus/runtime/cloudflare";
```

In-memory runtime assembly is resolver-owned. Consumers should enter through
`resolveRuntime` instead of hand-writing state, handler, or projection wiring.

Do not import submit-loop internals from `@yansirplus/runtime`. The runtime root
does not export `internalSubmitSpec`, `InternalSubmitSpec`, `submitAgentEffect`,
`buildInitialMessages`, `DEFAULT_LLM_CALL_TIMEOUT_MS`, or `turnRefOf`.

For normal first-party prepublish work, use the direct consumer overlay instead
of publishing npm versions or hand-writing tarball paths:

```sh
pnpm run install:consumer /path/to/consumer
```

The overlay writes `node_modules/.agentos-local.json`; the consumer
`package.json` and lockfile remain the registry contract. The marker records
the source revision, dirty bit, release package version, install-manifest digest,
tarball hashes, and local artifact kind. A stale marker means the consumer is
testing a known older local artifact, not current source HEAD. Inspect with:

```sh
pnpm run status:consumer /path/to/consumer
```

For machine consumers, prefer the `agentos` binary with JSON output:

```sh
agentos consumer status /path/to/consumer --json
agentos consumer check /path/to/consumer --json
```

The JSON projection has separate fields for:

- `truthMode`: package-manager release truth, current install-manifest overlay,
  or legacy overlay marker.
- `packageIntegrity`: installed package content and tarball digest verification.
- `sourceFreshness`: whether the local overlay was produced by the current
  source checkout.
- `gate.hardFailures[].dimension`: the failing axis, such as
  `package_integrity` or `source_freshness`.

Do not treat `sourceFreshness.status: "stale_source"` or
`"dirty_state_changed"` as package corruption. It means the local overlay was
produced by a different source checkout state. Re-run `agentos consumer install`
when testing current source; use `agentos consumer restore` when the product
should return to npm/lockfile truth.

If `node_modules` is missing, `install:consumer` runs the consumer package
manager install in frozen/non-interactive mode before overlaying packages.
For pnpm consumers this sets `CI=true` and uses `pnpm install --frozen-lockfile`.
Pass `--no-install` to fail closed instead. Restore with:

```sh
pnpm run restore:consumer /path/to/consumer
```

Use the local channel only when package-manager registry behavior is the thing
under test:

```sh
pnpm run registry:local
pnpm run publish:local
```

Consumer `.npmrc`:

```ini
@yansirplus:registry=http://127.0.0.1:4873
```

Consumer `package.json`:

```json
{
  "dependencies": {
    "@yansirplus/core": "agentos-dev",
    "@yansirplus/runtime": "agentos-dev",
    "@yansirplus/client": "agentos-dev",
    "@yansirplus/cli": "agentos-dev"
  }
}
```

Every `publish:local` call generates one unique prerelease version and moves
the `agentos-dev` dist-tag. The consumer lockfile pins the resolved package
version; the package manifest stays stable across worktrees.

## References

- [npm distribution](../distribution.md)
- [Runtime packages](../runtime-packages.md)
