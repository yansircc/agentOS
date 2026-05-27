# @agent-os/tenant-material Public API

Status: internal-stable, public-experimental. This package may be used by first-party agentOS runtime packages before its external API is frozen.

## Frozen exports

None.

## Experimental exports

- `.:EncryptedTenantCredentialRecord`
- `.:TenantCredentialAuditSummary`
- `.:TenantCredentialDecrypt`
- `.:TenantCredentialDecryptContext`
- `.:TenantCredentialDecryptInput`
- `.:TenantCredentialLookup`
- `.:TenantCredentialMaterial`
- `.:TenantCredentialResolutionFailureReason`
- `.:TenantCredentialResolutionRejection`
- `.:TenantCredentialResolverOptions`
- `.:TenantCredentialStore`
- `.:createTenantCredentialResolver`
- `.:summarizeTenantCredentialRecord`
- `.:tenantCredentialResolutionRejection`

## Internal-only exports

Any package file or symbol not listed above.
