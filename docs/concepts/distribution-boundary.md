# Distribution Boundary

## Problem

Independent agent apps cannot reliably consume source workspaces with
`workspace:` or `catalog:` dependencies outside the agentOS lockfile.

## Model

agentOS publishes internal npm packages as a fixed train. Source manifests stay
private; distribution tooling emits publish-only package projections. Consumer
apps install versioned packages and peers such as `effect`.

## Non-Goals

This concept does not define public npm release policy, changelog generation,
or live registry publishing.

## Related

- [Internal npm distribution](../distribution.md)
- [Consume internal packages](../guides/consume-internal-npm-packages.md)
