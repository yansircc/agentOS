# @agent-os/tenant-material

Status: internal-stable, public-experimental.

This package adapts encrypted tenant credential records to the core
`RefResolver` material axis. It does not store plaintext, does not read ambient
tenant/provider/purpose defaults, and does not provide plaintext passthrough.

Resolved credential material exists only as the return value of
`resolver.material(ref)`. Public summaries and rejection objects are symbolic:
tenant id, credential ref, provider, purpose, and failure reason only.
