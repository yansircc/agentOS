/**
 * Bounded introspection over a resolved runtime install graph.
 *
 * The source facts are the resolver-owned registration records. The maps here
 * are derived lookup indexes for diagnostics; they are not an alternate
 * registry used to install handlers or projections.
 *
 * @internal
 */

export interface ResolvedRuntimeGraphRegistration {
  readonly kind: string;
  readonly capabilityId: string;
}

export type ResolvedRuntimeGraphRegistrationStatus =
  | {
      readonly status: "installed";
      readonly kind: string;
      readonly capabilityId: string;
    }
  | {
      readonly status: "missing";
      readonly kind: string;
    };

export interface ResolvedRuntimeGraphStatusInput {
  readonly handlers?: Iterable<ResolvedRuntimeGraphRegistration>;
  readonly projections?: Iterable<ResolvedRuntimeGraphRegistration>;
}

export interface ResolvedRuntimeGraphStatus {
  readonly handlers: ReadonlyMap<string, ResolvedRuntimeGraphRegistration>;
  readonly projections: ReadonlyMap<string, ResolvedRuntimeGraphRegistration>;
  readonly handler: (kind: string) => ResolvedRuntimeGraphRegistrationStatus;
  readonly projection: (kind: string) => ResolvedRuntimeGraphRegistrationStatus;
}

const lookup = (
  map: ReadonlyMap<string, ResolvedRuntimeGraphRegistration>,
  kind: string,
): ResolvedRuntimeGraphRegistrationStatus => {
  const registration = map.get(kind);
  return registration === undefined
    ? { status: "missing", kind }
    : { status: "installed", kind, capabilityId: registration.capabilityId };
};

const registrationMap = (
  registrations: Iterable<ResolvedRuntimeGraphRegistration> | undefined,
): ReadonlyMap<string, ResolvedRuntimeGraphRegistration> =>
  new Map(Array.from(registrations ?? [], (registration) => [registration.kind, registration]));

export const defineResolvedRuntimeGraphStatus = (
  input: ResolvedRuntimeGraphStatusInput = {},
): ResolvedRuntimeGraphStatus => {
  const handlers = registrationMap(input.handlers);
  const projections = registrationMap(input.projections);
  return {
    handlers,
    projections,
    handler: (kind) => lookup(handlers, kind),
    projection: (kind) => lookup(projections, kind),
  };
};

export const emptyResolvedRuntimeGraphStatus = defineResolvedRuntimeGraphStatus();
