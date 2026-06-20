import { Schema } from "effect";

export const EXECUTION_IDENTITY_VERSION = "agent-execution-identity-v1" as const;

export interface ExecutionIdentityManifest {
  readonly agentId: string;
  readonly version?: string;
  readonly outputSchemaFingerprint?: string;
}

export interface ExecutionIdentityDeployment {
  readonly deploymentId: string;
  readonly backend: string;
  readonly adapter: string;
  readonly codec: string;
  readonly providerStrategy?: string;
}

/**
 * Execution provenance names the linked program and adapter surface that
 * produced a run. It is runtime evidence, not authority identity, and therefore
 * must never participate in ledger truth key derivation.
 *
 * @public
 */
export interface ExecutionIdentity {
  readonly version: typeof EXECUTION_IDENTITY_VERSION;
  readonly manifest: ExecutionIdentityManifest;
  readonly deployment: ExecutionIdentityDeployment;
}

const nonEmptyString = Schema.String.pipe(
  Schema.check(Schema.makeFilter((value) => value.length > 0)),
);

export const ExecutionIdentityManifestSchema: Schema.Decoder<ExecutionIdentityManifest> =
  Schema.Struct({
    agentId: nonEmptyString,
    version: Schema.optional(nonEmptyString),
    outputSchemaFingerprint: Schema.optional(nonEmptyString),
  });

export const ExecutionIdentityDeploymentSchema: Schema.Decoder<ExecutionIdentityDeployment> =
  Schema.Struct({
    deploymentId: nonEmptyString,
    backend: nonEmptyString,
    adapter: nonEmptyString,
    codec: nonEmptyString,
    providerStrategy: Schema.optional(nonEmptyString),
  });

export const ExecutionIdentitySchema: Schema.Decoder<ExecutionIdentity> = Schema.Struct({
  version: Schema.Literal(EXECUTION_IDENTITY_VERSION),
  manifest: ExecutionIdentityManifestSchema,
  deployment: ExecutionIdentityDeploymentSchema,
});

export const executionIdentityFromUnknown = (value: unknown): ExecutionIdentity | null => {
  try {
    return Schema.decodeUnknownSync(ExecutionIdentitySchema)(value);
  } catch {
    return null;
  }
};
