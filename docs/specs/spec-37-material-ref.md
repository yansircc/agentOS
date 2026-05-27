# Spec 37: MaterialRef Algebra

> **Status**: Draft v0.1
> **Date**: 2026-05-27
> **Trigger**: vibe and zeroY2 pressure exposed that credentials, endpoints,
> Durable Object bindings, D1/R2/KV/Queue/Workflow handles, and external
> provider resources are all execution-time material, but current refs are
> named only in local carrier shapes.
> **Depends on**: spec-24 INV-8, spec-28 dispatch binding refs, spec-34
> RefResolver, spec-36 EffectClaim calculus.

---

## 0. Purpose

agentOS already has local material refs:

- `LlmRoute.endpointRef` and `LlmRoute.credentialRef`;
- `RefResolver.material`;
- dispatch `bindingRef`;
- carrier-local handles such as Cloudflare API clients, Sandbox namespaces,
  D1 bindings, R2 buckets, queues, and Workflow classes.

Those are the same axis in different files: symbolic execution material that
is safe to name in a contract, but unsafe to resolve into ledger-visible data.
This spec names that axis without changing `PreClaim`.

---

## 1. Invariant

> **`PreClaim` names the intended effect. `MaterialRef` names execution
> mechanism. A material ref may be used by an admitter or resolver, but it is
> never part of effect identity and never resolves inside ledger payloads.**

Stable axis:

- symbolic ref kind: credential, endpoint, binding, external resource;
- authority contract declaring which material kinds are required;
- resolver boundary that turns symbolic refs into live carrier material.

Change axis:

- provider-specific ref strings;
- credential rotation and BYOK selection;
- endpoint migration;
- binding/resource topology;
- live handle types.

Rules:

- **M-1.** Same `operationRef` means same intended effect even if a retry uses
  different material. Personal token vs org token, rotated credential vs old
  credential, or renamed binding vs old binding is mechanism unless the
  semantic target changed.
- **M-2.** Material is acquire-side. Cleanup roots are release-side. They are
  related lifecycle refs but not the same type in v0.
- **M-3.** Ledger-visible data may contain only symbolic `MaterialRef`,
  required-material declarations, proof ids, receipts, or fingerprints. It
  must not contain resolved secrets, live handles, client objects, namespace
  objects, raw bytes, or provider response bodies.
- **M-4.** A missing material ref is a configuration/admission failure. It is
  not a fallback to ambient credentials.
- **M-5.** Provider-specific behavior belongs in the resolver. Shared substrate
  logic may switch on `MaterialRef.kind`, not on Cloudflare/OpenAI/WordPress
  implementation details.

---

## 2. Types

```ts
type MaterialRef =
  | { kind: "credential"; ref: string; provider?: string; purpose?: string }
  | { kind: "endpoint"; ref: string; protocol?: string }
  | {
      kind: "binding";
      provider: string;
      bindingKind: string;
      ref: string;
    }
  | {
      kind: "external_resource";
      provider: string;
      resourceKind: string;
      ref: string;
    };
```

Kind semantics:

| Kind                | Names                                                | Does not name                               |
| ------------------- | ---------------------------------------------------- | ------------------------------------------- |
| `credential`        | symbolic credential slot or tenant credential record | the secret value                            |
| `endpoint`          | symbolic endpoint slot                               | a resolved URL object or provider client    |
| `binding`           | runtime binding handle by provider/kind/ref          | serialized namespace/client/producer object |
| `external_resource` | provider-side account/site/project/resource identity | authority to mutate that resource by itself |

`ref` is opaque inside the kind. It may be an env key, tenant credential id,
binding name, account id, site id, or provider resource id. Cross-carrier
readers must not parse it.

---

## 3. Authority Contract

`AuthorityRef` says what right is being claimed. `MaterialRef` says which
mechanism will be acquired to exercise that right.

```ts
interface MaterialRequirement {
  readonly slot: string;
  readonly kind: MaterialRef["kind"];
  readonly required: boolean;
}

interface AuthorityContract {
  readonly authorityRef: AuthorityRef;
  readonly requiredMaterials: ReadonlyArray<MaterialRequirement>;
}
```

`MaterialRequirement` is a kind-specific filter, not a concrete ref. A
Cloudflare deploy authority can require:

```ts
{
  authorityRef: { authorityId: "cf.deploy_worker", authorityClass: "deploy" },
  requiredMaterials: [
    { slot: "api_token", kind: "credential", required: true, provider: "cloudflare" },
    { slot: "account", kind: "external_resource", required: true, provider: "cloudflare", resourceKind: "account" }
  ]
}
```

The caller or carrier supplies concrete `MaterialRef` values at resolution
time. The admitter can fail fast when required material is missing or when a
provided material kind does not satisfy the authority contract.

Rules:

- **A-1.** The required-material contract lives with the authority/tool/carrier
  contract, not inside `PreClaim`.
- **A-2.** `required: false` means the authority can operate without that
  material, but can use it when present. It is not a silent fallback to ambient
  global state.
- **A-3.** Requirement filters are kind-specific. A credential requirement does
  not accept binding fields, and an endpoint requirement does not accept
  provider/resource fields.

---

## 4. Resolver Boundary

`RefResolver` is the carrier-neutral material resolver:

```ts
interface RefResolver {
  material(ref: MaterialRef): ResolvedMaterial | null;
}
```

LLM and image providers still name `endpointRef` and `credentialRef` in their
route shape because those are protocol-level material slots. They resolve
through the same `material(ref)` boundary as non-secret material such as a D1
binding, R2 bucket, queue producer, Workflow class, Durable Object namespace,
or provider resource id. Core does not keep parallel endpoint/credential
resolver methods.

Resolver rules:

- **R-1.** Resolved values are process-local carrier material. They must not be
  written into ledger events, anchors, trace projections, or error payloads.
- **R-2.** Resolver failure is explicit. Missing material is a
  `RefResolutionFailed` or an admitted `RejectedClaim`, depending on whether
  the caller is inside a claim settlement boundary.
- **R-3.** A material resolver may branch on `MaterialRef.kind` and its
  provider metadata, but it must not expose parallel endpoint/credential
  resolver methods. Provider-specific fallback policy stays outside shared
  substrate logic.

---

## 5. Existing Mapping

| Current shape                       | MaterialRef mapping                                                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `LlmRoute.endpointRef`              | `{ kind: "endpoint", ref: endpointRef, protocol: route.kind }`                                                                 |
| `LlmRoute.credentialRef`            | `{ kind: "credential", ref: credentialRef, provider: route.kind, purpose: "llm_transport" }`                                   |
| `dispatch.target.bindingRef`        | `BindingMaterialRef`; CF DO targets use `{ kind: "binding", provider: "cloudflare", bindingKind: "durable_object", ref }`      |
| Cloudflare D1/R2/KV/Queue/Workflows | `@agent-os/cloudflare-resource` facts use `{ kind: "binding", provider: "cloudflare", bindingKind, ref }` for runtime bindings |
| Cloudflare account/site/project     | `{ kind: "external_resource", provider: "cloudflare", resourceKind, ref }`                                                     |
| WordPress site/plugin scope         | `ScopeRef.external` for ownership; material only if a carrier must acquire a WP client/token                                   |

`runtime-scope` cleanup roots are intentionally absent from the table. They are
release-side refs. A future `LeaseRef` may relate acquire and release, but v0
keeps `MaterialRef` scoped to acquisition/execution.

---

## 6. Non-Goals

- No fifth `PreClaim` field.
- No ledger source of truth for live handles.
- No global credential registry in core.
- No provider-specific resource enum frozen in core.
- No claim that credentials are the only material kind.

---

## 7. Acceptance

Spec acceptance:

- `operationRef` stays material-rotation stable.
- `AuthorityContract.requiredMaterials` exists and is kind-specific.
- `RefResolver` can resolve non-secret material without new ad-hoc interfaces.
- claim payloads, anchors, and readers have a hard symbolic-only redaction
  rule.
- cleanup roots are documented as release-side refs, not material.

Implementation acceptance:

- a tool/carrier contract can declare required materials;
- invalid material requirements fail registry validation;
- LLM route refs can be projected into `MaterialRef`;
- material resolution can return endpoint, credential, binding, and external
  resource handles without writing those handles to ledger.

Removal condition:

Any newly introduced provider-local ref resolver must be deleted before merge
unless it can state a distinct invariant that `MaterialRef` cannot carry. The
current repo has no compatibility users, so there is no endpoint/credential
parallel resolver surface.
