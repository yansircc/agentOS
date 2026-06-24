# agentOS Blueprints

Blueprints are app-applied recipes for third-party integrations. They are not
runtime public subpaths and they do not replace generated host targets.

Recipe files live under `blueprints/recipes/<kind>/<slug>.md`, start with JSON
frontmatter delimited by `---json` and `---`, and are validated by `agentos check
blueprint-recipes`.
