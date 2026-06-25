---json
{
  "schemaVersion": 1,
  "id": "channel.inbound",
  "kind": "channel",
  "title": "Inbound Channel Boundary",
  "summary": "Author provider ingress under agent/channels without moving provider lifecycle into runtime.",
  "primaryFile": "agent/channels/<name>.ts",
  "appliesTo": ["agentos add", "agentos update"],
  "upgradeGuide": "blueprints/UPGRADE.md",
  "channelBoundary": {
    "identity": "agent/channels/<name>.ts",
    "inboundRequest": "provider-native-raw-request",
    "authority": "verifier-derived-principal",
    "outboundSdk": "app-owned",
    "deduplication": "app-owned",
    "secretHandling": "redacted-before-submit-or-dispatch"
  }
}
---

# Inbound Channel Boundary

<!-- agentos:primary-file path="agent/channels/<name>.ts" -->

## Boundary

This recipe records the authored inbound channel boundary. A channel is a
provider ingress file under `agent/channels/<name>.ts`; the path stem is the
channel identity. The generated target mounts the compiled registry and passes
the provider-native `Request` to the handler without wrapping the body.

## Channel Boundary

The channel file owns request verification and maps a verified provider signal
to a principal. The request body, headers, and provider payload remain data for
the handler. Authority comes from the verifier-derived principal, not from a
provider payload claim.

The channel dispatch context exposes only `principal`, `submit`, and
`dispatch`. Provider SDK clients, outbound provider calls, lifecycle creation,
deduplication, retries, and webhook response URL handling stay in app-owned
channel code or app-owned tools. Raw secrets, webhook tokens, and provider
response URLs must be redacted before calling `submit` or `dispatch`.

## Steps

1. Add `agent/channels/<name>.ts`.
2. Export a `defineChannel` declaration with a verifier and one or more HTTP
   method routes.
3. Read the raw provider `Request` inside the handler.
4. Use the verifier-derived principal when deciding whether to call `submit` or
   `dispatch`.
5. Keep provider SDK clients and deduplication state outside runtime public
   exports.

## Upgrade Guide

`blueprints/UPGRADE.md` owns cumulative migration notes for this recipe.
