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
   `bun run agentos -- build --cwd /path/to/consumer --package-scope
@yansirplus`. This makes generated imports use the public `@yansirplus` scope
   instead of source workspace packages.
5. For prepublish first-party work, run `bun run install:consumer --
/path/to/consumer` in agentOS. This overlays the generated final public package
   projection into the consumer `node_modules` without changing the consumer
   manifest or lockfile.
6. Restore the consumer to registry truth with `bun run restore:consumer --
/path/to/consumer`.
7. If the consumer must exercise registry or dist-tag behavior instead, run a
   local registry channel: `bun run registry:local`, then `bun run
publish:local` in agentOS.
8. Read `dist/internal-npm/local-channel.json`.
9. Copy the required `dependencies` entries into the consumer app. Use the
   logical tag value, for example `agentos-dev`; do not copy worktree tarball
   paths. Configure `@yansirplus:registry` once in the consumer `.npmrc` only
   when consuming the local channel.
10. Run the app typecheck and tests under its own lockfile.

For normal first-party prepublish work, use the direct consumer overlay instead
of publishing npm versions or hand-writing tarball paths:

```sh
bun run install:consumer -- /path/to/consumer
```

The overlay writes `node_modules/.agentos-local.json`; the consumer
`package.json` and lockfile remain the registry contract. Restore with:

```sh
bun run restore:consumer -- /path/to/consumer
```

Use the local channel only when package-manager registry behavior is the thing
under test:

```sh
bun run registry:local
bun run publish:local
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
