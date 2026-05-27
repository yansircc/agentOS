/**
 * @agent-os/tenant-material — encrypted tenant credential resolver.
 *
 * Status: internal-stable, public-experimental.
 *
 * Stable axis: core MaterialRef + RefResolver. Change axis: encrypted tenant
 * credential storage. Resolved credential material is produced only by
 * resolver.material(ref) at execution time; public artifacts remain symbolic.
 */

import type { CredentialMaterialRef, MaterialRef } from "@agent-os/core/material-ref";
import type { RefResolver } from "@agent-os/core/ref-resolver";

export type TenantCredentialMaterial = string | Uint8Array;

export interface TenantCredentialLookup {
  readonly tenantId: string;
  readonly ref: string;
  readonly provider: string;
  readonly purpose: string;
}

export interface TenantCredentialDecryptContext extends TenantCredentialLookup {
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface EncryptedTenantCredentialRecord extends TenantCredentialLookup {
  readonly encryptedBytes: Uint8Array;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface TenantCredentialDecryptInput {
  readonly encryptedBytes: Uint8Array;
  readonly context: TenantCredentialDecryptContext;
}

export type TenantCredentialDecrypt = (
  input: TenantCredentialDecryptInput,
) => TenantCredentialMaterial | ArrayBuffer;

export interface TenantCredentialStore {
  readonly get: (lookup: TenantCredentialLookup) => EncryptedTenantCredentialRecord | null;
}

export interface TenantCredentialResolverOptions {
  readonly tenantId: string;
  readonly store: TenantCredentialStore;
  readonly decrypt: TenantCredentialDecrypt;
}

export type TenantCredentialResolutionFailureReason =
  | "non_credential_ref"
  | "missing_provider"
  | "missing_purpose"
  | "missing_record"
  | "tenant_mismatch"
  | "ref_mismatch"
  | "provider_mismatch"
  | "purpose_mismatch"
  | "invalid_encrypted_bytes"
  | "decrypt_failed"
  | "invalid_resolved_material";

export interface TenantCredentialResolutionRejection {
  readonly kind: "tenant_credential_resolution_rejected";
  readonly tenantId: string;
  readonly ref: string;
  readonly provider?: string;
  readonly purpose?: string;
  readonly reason: TenantCredentialResolutionFailureReason;
}

export interface TenantCredentialAuditSummary {
  readonly kind: "tenant_credential_record";
  readonly tenantId: string;
  readonly ref: string;
  readonly provider: string;
  readonly purpose: string;
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isUint8Array = (value: unknown): value is Uint8Array => value instanceof Uint8Array;

const isArrayBuffer = (value: unknown): value is ArrayBuffer => value instanceof ArrayBuffer;

const isCredentialRef = (ref: MaterialRef): ref is CredentialMaterialRef =>
  ref.kind === "credential";

const toResolvedMaterial = (value: unknown): TenantCredentialMaterial | null => {
  if (typeof value === "string") return value;
  if (isUint8Array(value)) return value;
  if (isArrayBuffer(value)) return new Uint8Array(value);
  return null;
};

const validateOptions = (options: TenantCredentialResolverOptions): void => {
  if (!isNonEmptyString(options.tenantId)) {
    throw new TypeError("@agent-os/tenant-material requires a non-empty tenantId");
  }
};

const matchesLookup = (
  record: EncryptedTenantCredentialRecord,
  lookup: TenantCredentialLookup,
): TenantCredentialResolutionFailureReason | null => {
  if (record.tenantId !== lookup.tenantId) return "tenant_mismatch";
  if (record.ref !== lookup.ref) return "ref_mismatch";
  if (record.provider !== lookup.provider) return "provider_mismatch";
  if (record.purpose !== lookup.purpose) return "purpose_mismatch";
  if (!isUint8Array(record.encryptedBytes)) return "invalid_encrypted_bytes";
  return null;
};

export const tenantCredentialResolutionRejection = (spec: {
  readonly tenantId: string;
  readonly ref: Pick<CredentialMaterialRef, "ref" | "provider" | "purpose">;
  readonly reason: TenantCredentialResolutionFailureReason;
}): TenantCredentialResolutionRejection => ({
  kind: "tenant_credential_resolution_rejected",
  tenantId: spec.tenantId,
  ref: spec.ref.ref,
  ...(spec.ref.provider === undefined ? {} : { provider: spec.ref.provider }),
  ...(spec.ref.purpose === undefined ? {} : { purpose: spec.ref.purpose }),
  reason: spec.reason,
});

export const summarizeTenantCredentialRecord = (
  record: EncryptedTenantCredentialRecord,
): TenantCredentialAuditSummary => ({
  kind: "tenant_credential_record",
  tenantId: record.tenantId,
  ref: record.ref,
  provider: record.provider,
  purpose: record.purpose,
});

export const createTenantCredentialResolver = (
  options: TenantCredentialResolverOptions,
): RefResolver => {
  validateOptions(options);

  return {
    material: (ref: MaterialRef): TenantCredentialMaterial | null => {
      if (!isCredentialRef(ref)) return null;
      if (!isNonEmptyString(ref.provider)) return null;
      if (!isNonEmptyString(ref.purpose)) return null;

      const lookup: TenantCredentialLookup = {
        tenantId: options.tenantId,
        ref: ref.ref,
        provider: ref.provider,
        purpose: ref.purpose,
      };
      const record = options.store.get(lookup);
      if (record === null) return null;

      if (matchesLookup(record, lookup) !== null) return null;

      try {
        return toResolvedMaterial(
          options.decrypt({
            encryptedBytes: record.encryptedBytes,
            context: {
              tenantId: record.tenantId,
              ref: record.ref,
              provider: record.provider,
              purpose: record.purpose,
              ...(record.metadata === undefined ? {} : { metadata: record.metadata }),
            },
          }),
        );
      } catch {
        return null;
      }
    },
  };
};
