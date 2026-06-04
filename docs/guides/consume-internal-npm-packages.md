# Consume Internal npm Packages

## Outcome

An independent agent app can install agentOS through versioned internal npm
packages instead of sharing the agentOS source workspace lockfile.

## Prerequisites

- [Distribution boundary](../concepts/distribution-boundary.md)
- [Internal npm distribution](../distribution.md)

## Steps

1. Configure the private `@agent-os` registry.
2. Install required packages with semver versions.
3. Install required peers such as `effect`.
4. For prepublish first-party work, run `bun run build:internal-packages` and
   `bun run pack:internal` in agentOS.
5. Read `dist/internal-npm/install-manifest.json`.
6. Copy the required `dependencies` and `overrides` entries into the consumer
   app. Use the manifest `spec` values, not `file:` package directories.
   Manifest specs point at content-addressed `.tgz` files so package managers
   do not reuse stale same-version tarballs after a local repack.
7. Run the app typecheck and tests under its own lockfile.

For first-party prepublish work, use the generated internal install manifest
instead of hand-writing tarball paths:

```sh
bun run pack:internal
```

Copy the required `@agent-os/*` entries from
`dist/internal-npm/install-manifest.json` into the consumer `dependencies` and
copy the same entries into `overrides`. The manifest uses content-addressed
`.tgz` file specs so local package managers do not silently keep a stale
same-version tarball.

## References

- [Internal npm distribution](../distribution.md)
- [Runtime packages](../runtime-packages.md)
