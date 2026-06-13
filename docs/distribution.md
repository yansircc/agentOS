# npm Distribution

agentOS app repos consume published `@yansirplus/*` packages from npm, not
source workspace packages. Source package manifests stay private and may keep
`workspace:` / `catalog:` for monorepo development. `tooling/distribution`
generates publish-only package projections under `dist/internal-npm`.

## Install

Install agentOS packages plus required peers:

```sh
bun add @yansirplus/runtime @yansirplus/backend-cloudflare-do effect
```

Cloudflare-targeted packages also peer depend on
`@cloudflare/workers-types`. Worker apps should install a compatible version
from the release manifest before typechecking Cloudflare-facing code.

## Publish

```sh
export AGENTOS_NPM_REGISTRY=https://registry.npmjs.org/
bun run publish:internal
```

`package.json` `agentOsRelease.npmScope` owns the published npm scope.
`agentOsRelease.npmAccess` owns the default publish access. Override them only
for isolated tests with `AGENTOS_NPM_SCOPE` or `AGENTOS_NPM_ACCESS`.

For first-party prepublish consumers, run:

```sh
bun run registry:local
bun run publish:local
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
    "@yansirplus/runtime": "agentos-dev",
    "@yansirplus/backend-cloudflare-do": "agentos-dev"
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
bun run check:distribution
bun run test:internal-consumer
```

The checks reject generated package manifests or tarballs that expose
`workspace:`, `catalog:`, `private`, source `.ts` entrypoints, tests, config,
or deep `/src/` declaration paths.

## Source Maps

The v1 distribution does not ship source maps. Published stack traces point at
generated `dist/*.js` files. Add source maps in a later release only if
production debugging repeatedly needs source-line mapping.
