# Verify An agentOS App

## Outcome

You can prove an agentOS app is using the substrate boundary without relying on
review-only checks.

## Prerequisites

- [Durable truth](../concepts/durable-truth.md)
- [Distribution boundary](../concepts/distribution-boundary.md)
- [Verification](../verification.md)

## Steps

1. Run package or app unit tests first.
2. Run TypeScript under the app resolver.
3. Run consumer or distribution fixtures when npm packages changed.
4. Run runtime harnesses for Durable Object, storage, or facade changes.
5. Run whitespace and Effect scanner checks before commit.

## References

- [Verification](../verification.md)
- [Boundary contract](../boundary-contract.md)
