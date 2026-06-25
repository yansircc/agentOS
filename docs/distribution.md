# npm Distribution

agentOS app repos consume published `@yansirplus/*` packages from npm, not
source workspace packages. Source package manifests stay private and may keep
`workspace:` / `catalog:` for monorepo development. `tooling/distribution`
generates publish-only package projections under `dist/internal-npm`.

Generated Cloudflare targets must also project imports to the public package
scope before they leave the monorepo:

```sh
pnpm run agentos build --cwd /path/to/consumer --package-scope @yansirplus
```

`--package-scope @yansirplus` is the switch that makes generated target files
import `@yansirplus/*` packages. Source names such as `@agent-os/*`, package
manager protocols such as `workspace:*` and `catalog:`, and manual symlinks are
not consumer surfaces.

## Public Surface Convergence

The npm surface is split by entrypoint audience, not by whole package:

- `default-direct`: hand-written consumer imports, currently `@yansirplus/cli`
  and `@yansirplus/client` roots plus client framework subpaths.
- `generated-only`: imports emitted by agentOS generated targets, such as
  `@yansirplus/runtime/workspace-binding`,
  `@yansirplus/core/runtime-protocol`, and `@yansirplus/core/tools`.
- `advanced`: backend or substrate author imports, such as
  `@yansirplus/runtime/cloudflare`, `@yansirplus/runtime/node`, and
  `@yansirplus/runtime/in-memory`.

The `@yansirplus/runtime` root is an explicit allowlist. It no longer exports
module-private submit-loop helpers such as `internalSubmitSpec`,
`InternalSubmitSpec`, `submitAgentEffect`, `buildInitialMessages`,
`DEFAULT_LLM_CALL_TIMEOUT_MS`, or `turnRefOf`. Consumers should call the backend
or generated target surface instead of importing these internals.

See [0.6.0 release notes](release-notes/0.6.0.md) for the migration table.

## Install

Install agentOS packages plus required peers:

```sh
pnpm add @yansirplus/core @yansirplus/runtime @yansirplus/client @yansirplus/cli effect
```

Cloudflare-targeted runtime subpaths also peer depend on
`@cloudflare/workers-types`. Optional integration subpaths such as
`@yansirplus/runtime/llm-effect-ai`, `@yansirplus/client/react`, and
`@yansirplus/client/svelte` require their matching optional peers only when
the consumer imports that subpath.

`@yansirplus/runtime/llm-effect-ai/openai-compatible` is the OpenAI-compatible
provider boundary and does not require `@effect/ai-anthropic`. The package unit
manifest keeps `@effect/ai-anthropic` localized to
`@yansirplus/runtime/llm-effect-ai/anthropic`; packed consumer proof imports and
runs the OpenAI-compatible subpath with no Anthropic package installed. The npm
`peerDependencies` field is package-level metadata, so the Anthropic peer can be
optional but cannot be scoped to one export in `package.json`. A provider package
split becomes required if package-level optional peers start forcing installs, or
if the OpenAI-compatible subpath import graph reaches Anthropic code.

## Publish

```sh
export AGENTOS_NPM_REGISTRY=https://registry.npmjs.org/
pnpm run publish:internal
```

`package.json` `agentOsRelease.npmScope` owns the published npm scope.
`agentOsRelease.npmAccess` owns the default publish access. Override them only
for isolated tests with `AGENTOS_NPM_SCOPE` or `AGENTOS_NPM_ACCESS`.

For first-party prepublish consumers that need to test current source without
publishing an npm version, install the generated package projection directly
into the consumer `node_modules`:

```sh
pnpm run install:consumer /path/to/consumer
```

`install:consumer` runs the same package projection and tarball pack path as a
release, overlays the generated `@yansirplus/*` packages into the consumer
`node_modules`, and writes `node_modules/.agentos-local.json` with the source
revision, release package version, install-manifest digest, tarball hashes, and
local artifact kind. The marker is proof of a local tarball overlay, not proof
that the same version is published on npm. It must not edit the consumer
`package.json` or lockfile. If `node_modules` is missing, the command runs the
consumer package manager install in frozen/non-interactive mode before applying
the overlay; pass `--no-install` to fail closed instead.

Read the current consumer state with:

```sh
pnpm run status:consumer /path/to/consumer
pnpm run status:consumer -- /path/to/consumer --json
pnpm run status:consumer -- /path/to/consumer --check-npm
```

Without `--check-npm`, registry latest is reported as `not_checked`; this keeps
normal local overlay work offline and makes the unknown registry state explicit.
Restore the consumer to registry truth with:

```sh
pnpm run restore:consumer /path/to/consumer
```

Use the local registry channel only when the consumer must exercise package
manager registry resolution, dist-tags, or npmrc behavior:

```sh
pnpm run registry:local
pnpm run publish:local
```

Then configure the consumer once:

```ini
@yansirplus:registry=http://127.0.0.1:4873
```

Consumer `package.json` should depend on the logical channel, not a worktree
path:

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

`publish:local` writes `dist/internal-npm/local-channel.json` with the registry,
tag, generated prerelease version, and copyable dependency snippets. It also
packs tarballs for audit under `dist/internal-npm/tarballs`, but consumer apps
should not copy those `file:` paths for active first-party development.

The local Verdaccio registry state is developer tool state, not distribution
output. By default `registry:local` stores config, auth, and package storage
under `~/.agentos/local-registry`; set `AGENTOS_LOCAL_REGISTRY_ROOT` only when a
different persistent registry root is required. Do not place registry state
under `dist/internal-npm`, because pack and publish commands own that directory.

## Release Train

Published packages ship as one fixed train. `package.json`
`agentOsRelease.version` is the single source for the release version. The
`0.2.9 -> 0.2.10` path publishes every package declared with
`"published": true` in `docs/surface.json`; breaking package contracts move the
train to `0.3.0`.

Do not rely on `npm unpublish` for rollback. Publish a new fixed-train patch
release with the correction.

## Checks

Run distribution gates before publishing:

```sh
pnpm run check:distribution
pnpm run test:internal-consumer
```

The checks reject generated package manifests or tarballs that expose
`workspace:`, `catalog:`, `private`, source `.ts` entrypoints, tests, config,
or deep `/src/` declaration paths.

`test:internal-consumer` also builds an external generated target with
`--package-scope @yansirplus`, installs packed public packages into a clean
consumer `node_modules`, rejects symlinked agentOS packages, and bundles the
generated Cloudflare worker entry.
It also proves against packed package content that removed runtime root
submit-loop internals are absent from both TypeScript declarations and runtime
module exports.

## Source Maps

The v1 distribution does not ship source maps. Published stack traces point at
generated `dist/*.js` files. Add source maps in a later release only if
production debugging repeatedly needs source-line mapping.
