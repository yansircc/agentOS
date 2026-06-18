# Authoring Freeze

This file is the source owner for Phase 7 authoring grammar and compiler
contracts. Implementation tasks may cite this file; CST evidence must not copy
it into a second source table.

## Axes

```text
stable axis: pre-runtime authored intent
change axis: filesystem syntax and generated runtime artifacts
invariant: authored files compile to one normalized AgentManifest<Authored>;
runtime facts, live material, generated clients, backend classes, and projection
outputs are never manifest facts.
```

## Authored Root

An authored agent root is a directory named `agent/`. The directory is the only
author-owned source for pre-runtime intent.

```text
agent/
  instructions.md
  agent.json
  tools/
    <tool-id>.ts
  materials/
    <material-id>.json
  domains/
    <domain-id>.json
  interactions/
    <interaction-id>.json
```

Only `instructions.md` is required. Other files are optional declarations.
`agent.json` may supply root-level scalar declarations and references, but it
may not rename path-owned entries.

Path segments are identities. A path-derived entry must not contain a `name`,
`id`, or `kind` field that repeats or overrides the path identity. The compiler
derives:

- `agent/tools/weather.ts` -> tool key `weather`
- `agent/materials/openai.json` -> material key `openai`
- `agent/domains/app-runtime.json` -> execution-domain key `app-runtime`
- `agent/interactions/approval.json` -> interaction key `approval`

Nested paths are rejected until a grammar version explicitly defines namespace
escaping. Case-insensitive path collisions are build failures.

## Value Layers

The compiler flattens value layers under an L0 constraint layer.

```text
L0 constraints                       no values; only accept or reject
L1 framework-defaults@agentos/v1     versioned defaults owned by framework
L2 scaffold output                   initial files written by init
L3 authored tree                     current author-owned files under agent/
```

`L2` is not a durable second source. After scaffold files are written into
`agent/`, the files are ordinary authored tree facts. The scaffold layer exists
only in compiler provenance for generated files that have not been edited yet.

Flattening is deterministic:

- each fact key has a fully qualified path such as
  `/tools/weather/executionDomain`;
- duplicate suppliers inside the same layer are build failures;
- higher layers may override lower-layer defaults only for keys marked
  `overrideable`;
- constraints are not values and cannot be overridden;
- the normalized manifest records the highest supplying origin for every fact.

Origin values are:

```text
path:<relative authored path>
author:<relative authored path>#<json-pointer-or-export>
scaffold:<scaffold-id>@<version>#<fact-key>
default:framework-defaults@agentos/v1#<fact-key>
```

The origin map is part of the compiler output. It is diagnostic metadata for
the manifest compiler and generated views, not runtime truth.

## Defaults

Defaults are values only when they have an owner and version.

`framework-defaults@agentos/v1` supplies:

- `/scope` = `{ "kind": "conversation", "idSource": "submit_scope" }`
- `/effectAuthorityRef` =
  `{ "authorityClass": "agent", "authorityId": "<agentId>" }`
- `/llmRoutes/default/bindingRef` = `llm.default`
- pure tool `/tools/<tool-id>/executionDomain` = `app-runtime`
- pure tool `/tools/<tool-id>/interaction` = `never`

These defaults are overrideable by authored files.

The framework supplies no default for:

- material refs;
- secrets or provider credentials;
- effectful tool interaction;
- effectful tool execution domain;
- receipt or replay policy;
- schedules or actual trigger times;
- continuation refs, snapshots, or resume payloads.

If a tool declares any material, workspace mutation, network access, dispatch,
provider call, or other non-local effect, the tool is effectful. Effectful tools
must explicitly declare:

- required material refs, when any material is used;
- execution domain;
- interaction policy;
- receipt/replay policy.

Missing effectful declarations are L0 failures. The compiler must not backfill
them with defaults.

## Normalized Manifest

The compiler output has two products:

```text
manifest: AgentManifest<Authored>
provenance: Record<factKey, origin>
```

`AgentManifest<Authored>` contains only pre-runtime intent:

- agent id and optional version;
- instructions reference and digest;
- scope policy;
- effect authority ref;
- handler kinds;
- symbolic llm route binding refs;
- symbolic tool binding refs;
- symbolic capability binding refs;
- symbolic material refs;
- output schema intent;
- tool declarations, execution-domain refs, interaction refs, and policy refs.

It never contains:

- Durable Object classes, Worker entries, typed clients, route registration, or
  stream registration;
- resolved material, credentials, provider URLs, provider-native clients, file
  bytes, sandbox handles, or live callback tokens;
- ledger events, `ContinuationRef`, `InputRequestRef`, snapshots, receipts, or
  actual trigger fire times;
- generated projection views, docs, UI data, stream frames, or eval results;
- executable closures.

Backend mount interprets `AgentManifest<Authored>` into exactly:

```text
driver configuration
projection sink configuration[]
```

There is no third output category. Generated typed clients, Durable Object
classes, Worker entries, route handlers, docs, stream registrations, and `/info`
JSON are projections from the manifest or backend mount output. They must not
be copied back into the manifest.

## L0 Constraints

The compiler fails closed when any constraint is violated:

- `agent/instructions.md` must exist and be non-empty.
- Every path-derived identity is unique.
- Any duplicate fact key within one value layer is an error.
- Runtime facts are forbidden in all value layers.
- `Live<T>` material and resolved provider values are forbidden in all value
  layers.
- `ContinuationRef`, `InputRequestRef`, snapshots, actual trigger times, and
  resume payloads are forbidden in authored files.
- Effectful tools must declare material, domain, interaction, and receipt/replay
  policy according to the defaults section.
- Authored schema defaults that erase provenance are forbidden. Defaults live in
  value layers, not inside schema decode behavior.
- Manifest fields must be JSON-serializable and function-free.

The same L0 predicate family has a runtime interpreter over ledger
transitions. The compile-time interpreter checks `AgentManifest<Authored>` and
provenance; the runtime interpreter checks `Recorded` ledger transitions. They
share predicates but not value sources.

## Conflict Examples

These are required negative cases for the implementation task:

- `agent/tools/weather.ts` plus `agent/agent.json` declaring
  `/tools/weather/bindingRef` in the same authored layer -> build failure.
- two files whose normalized path key is `tools/weather` -> build failure.
- an effectful tool that references a material but omits material declaration ->
  build failure.
- an effectful tool with no interaction policy -> build failure.
- an effectful tool with no execution domain -> build failure.
- a tool schema using decode-time defaults to manufacture required values ->
  build failure.
- a file declaring a continuation token, snapshot, actual trigger time, or
  resolved secret -> build failure.

Positive compiler output must explain the origin of every manifest fact. For
example a pure `agent/tools/weather.ts` with no explicit domain produces:

```text
/tools/weather/executionDomain
  value: app-runtime
  origin: default:framework-defaults@agentos/v1#/tools/<tool-id>/executionDomain
```

If the author later adds `agent/domains/workspace.json` and points the tool at
it, the same fact key has:

```text
origin: author:agent/tools/weather.ts#executionDomain
```

## Phase 7 Exit Criteria

Phase 7 implementation is done only when:

- app authors can build a runnable agent without importing `@agent-os/kernel`;
- the compiler returns a normalized manifest and provenance map;
- duplicate fact keys fail by construction;
- effectful missing material/domain/interaction/receipt cases fail by L0;
- pure tool defaults are visible with `default:framework-defaults@agentos/v1`
  origin;
- generated `/info`, CLI, docs, and typed client views derive from the manifest
  projection instead of becoming manifest fields;
- the web-cursor spike app-author kernel-import ratchet reaches zero.
