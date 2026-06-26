# agentOS Blueprints

Blueprints are app-applied recipes for third-party integrations. They are not
runtime public subpaths and they do not replace generated host targets.

Recipe files live under `blueprints/recipes/<kind>/<slug>.md`, start with JSON
frontmatter delimited by `---json` and `---`, and are validated by `agentos check
blueprint-recipes`.

Provider and sandbox recipes must declare `lifecycleOwnership` for create, reuse,
delete, credentials, and network policy. Channel and schedule recipes must
declare their ingress boundary axes. Those axes belong to app-owned or generated
target code; runtime exposes stable contracts and pure adapters only.
