# @agent-os/tenant-material Public API

Status: 0.2.x public-experimental. This package may be used by first-party
agentOS runtime packages, but its public API is not frozen.

## Public exports

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
- `.:TenantCredentialResolverConfigurationError`
- `.:TenantCredentialResolverConfigurationReason`
- `.:TenantCredentialResolverOptions`
- `.:TenantCredentialStore`
- `.:createTenantCredentialResolver`
- `.:summarizeTenantCredentialRecord`
- `.:tenantCredentialResolutionRejection`

## Internal-only exports

Any package file or symbol not listed above.
