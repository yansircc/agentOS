# Core Model

`@agent-os/core` owns the substrate algebra.

## Durable Truth

The ledger is the durable source of truth. Schedules, streams, indexes, traces,
and UI projections are derived from ledger facts plus terminal submit results.

Do not create a second run state.

## Effect Identity

`PreClaim` names intended effect identity:

```text
operationRef + scopeRef + authorityRef + originRef
```

Material does not enter effect identity. Credential rotation, endpoint
rotation, BYOK changes, and binding migration must not change the idempotent
identity of the same intended effect.

## Execution Material

`MaterialRef` names execution means:

```text
credential | endpoint | binding | external_resource
```

Resolved material is available only at execution time through `RefResolver`.
Resolved secrets, raw handles, SQL, object bytes, queue bodies, and provider
responses never enter ledger-visible payloads.

## Tools

Tools are registered through `defineRegisteredTool`. A tool contract declares:

- tool definition;
- authority class and optional authority id;
- required materials;
- admitter;
- executor.

`ToolContract` is the runtime identity. Skill identity, if used, stops at
install time.

## Boundary Contracts

Packages that carry claim-bearing facts declare a `BoundaryContract`. Core
validates the package's event vocabulary, authority contracts, material axis,
symbolic proof surface, and projection contract.

## Public API

The frozen public core surface is listed in
[`packages/core/PUBLIC_API.md`](../packages/core/PUBLIC_API.md). Symbols not
listed there are internal.
