# Blueprint Upgrade Guide

<!-- agentos:blueprint-upgrade id="provider.material-binding" -->

## provider.material-binding

Keep provider material binding as app-owned configuration. Do not move provider
SDK imports, secret preflight, or transport-specific wiring into
`@agent-os/runtime`.
