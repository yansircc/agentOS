# agentOS Integration Checklist

Use this checklist when migrating an app to agentOS.

1. Identify current durable truth. Replace custom run state with ledger facts or
   derived projections.
2. Identify intended effects. Model identity with `PreClaim`; keep material out
   of operation identity.
3. Identify execution material. Use symbolic `MaterialRef` values and resolve
   only at execution time.
4. Identify tool gates. Use `ToolContract` and admitters instead of app-local
   boolean gates.
5. Identify progress streams. Use turn frames for non-durable UI progress and
   run-stream for consumer composition.
6. Identify provider resources. Keep lifecycle proofs in carriers and raw data
   in provider-owned data stores.
7. Remove fallback paths. Missing material, unsupported scopes, and unsupported
   resource kinds must fail closed.
