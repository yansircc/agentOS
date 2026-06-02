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
4. Run the app typecheck and tests under its own lockfile.

## References

- [Internal npm distribution](../distribution.md)
- [Runtime packages](../runtime-packages.md)
