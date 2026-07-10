import { Effect } from "effect";
import { JsonStringifyError } from "@agent-os/core/errors";
import type { EventQueryOptions, LedgerEvent, LedgerEventRpc } from "@agent-os/core/types";
import {
  backendProtocolEventIdentityKey,
  backendProtocolProjectionKey,
  backendProtocolTruthIdentityKey,
  normalizeBackendPageLimit,
  type BackendProtocolEventIdentity,
  type BackendProtocolProjectionKey,
  type BackendProtocolTruthIdentity,
} from "@agent-os/core/backend-protocol";
import { RUNTIME_FACT_OWNER } from "@agent-os/core/runtime-protocol";
import type { MaterializedProjectionRow } from "../projection";
import type { InMemoryProjectionMeta } from "./state";

export const canonicalSerializablePayload = (
  payload: unknown,
): Effect.Effect<unknown, JsonStringifyError> =>
  Effect.gen(function* () {
    const serialized = yield* Effect.try({
      try: () => JSON.stringify(payload),
      catch: (cause) => new JsonStringifyError({ cause }),
    });
    if (typeof serialized !== "string") {
      return yield* Effect.fail(
        new JsonStringifyError({ cause: "ledger event payload must be JSON serializable" }),
      );
    }
    return JSON.parse(serialized) as unknown;
  });

export const canonicalSerializablePayloadSync = (payload: unknown): unknown =>
  Effect.runSync(canonicalSerializablePayload(payload)); // eff-ignore EFF400 reason="in-memory transaction callbacks are synchronous and must observe the same canonical payload decoder"

export const canonicalLedgerEventSync = (event: LedgerEvent): LedgerEvent => ({
  ...event,
  payload: canonicalSerializablePayloadSync(event.payload),
});

export const canonicalLedgerEvent = (
  event: LedgerEvent,
): Effect.Effect<LedgerEvent, JsonStringifyError> =>
  Effect.map(canonicalSerializablePayload(event.payload), (payload) => ({ ...event, payload }));

export const canonicalLedgerEvents = (
  events: ReadonlyArray<LedgerEvent>,
): Effect.Effect<ReadonlyArray<LedgerEvent>, JsonStringifyError> =>
  Effect.forEach(events, canonicalLedgerEvent);

export const normalizeNonNegativeInteger = (value: number | undefined, fallback: number): number =>
  value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, Math.floor(value));

export const describeFanoutCause = (cause: unknown): string => {
  if (typeof cause === "string") return cause;
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  return Object.prototype.toString.call(cause);
};

export const inMemoryRuntimeEventIdentity = (
  identity: BackendProtocolTruthIdentity,
): BackendProtocolEventIdentity => ({
  scopeRef: identity.scopeRef,
  effectAuthorityRef: identity.effectAuthorityRef,
  factOwnerRef: RUNTIME_FACT_OWNER,
});

export const inMemoryConversationTruthIdentity = (
  scopeId: string,
): BackendProtocolTruthIdentity => ({
  scopeRef: { kind: "conversation", scopeId },
  effectAuthorityRef: { authorityClass: "effect", authorityId: scopeId },
});

export const inMemoryConversationRuntimeIdentity = (
  scopeId: string,
): BackendProtocolEventIdentity =>
  inMemoryRuntimeEventIdentity(inMemoryConversationTruthIdentity(scopeId));

export const eventIdentity = (event: LedgerEvent): BackendProtocolEventIdentity => ({
  scopeRef: event.scopeRef,
  effectAuthorityRef: event.effectAuthorityRef,
  factOwnerRef: event.factOwnerRef,
});

export const eventTruthIdentity = (event: LedgerEvent): BackendProtocolTruthIdentity => ({
  scopeRef: event.scopeRef,
  effectAuthorityRef: event.effectAuthorityRef,
});

export const eventMatches = (event: LedgerEvent, identity: BackendProtocolEventIdentity): boolean =>
  backendProtocolEventIdentityKey(eventIdentity(event)) ===
  backendProtocolEventIdentityKey(identity);

export const eventDisplayScope = (identity: BackendProtocolEventIdentity): string =>
  backendProtocolEventIdentityKey(identity);

export interface RuntimeTransitionEventGroup {
  readonly identity: BackendProtocolTruthIdentity;
  readonly events: LedgerEvent[];
  hasRuntimeEvent: boolean;
}

export const groupRuntimeTransitionEventsByTruthIdentity = (
  events: ReadonlyArray<LedgerEvent>,
): ReadonlyArray<RuntimeTransitionEventGroup> => {
  const groups = new Map<string, RuntimeTransitionEventGroup>();
  for (const event of events) {
    const identity = eventTruthIdentity(event);
    const key = backendProtocolTruthIdentityKey(identity);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, {
        identity,
        events: [event],
        hasRuntimeEvent: event.factOwnerRef === RUNTIME_FACT_OWNER,
      });
    } else {
      group.events.push(event);
      group.hasRuntimeEvent ||= event.factOwnerRef === RUNTIME_FACT_OWNER;
    }
  }
  return Array.from(groups.values()).filter((group) => group.hasRuntimeEvent);
};

export const eventMatchesQueryOptions = (
  event: LedgerEvent,
  opts: Pick<EventQueryOptions, "afterId" | "kinds">,
): boolean => {
  const afterId = normalizeNonNegativeInteger(opts.afterId, 0);
  if (event.id <= afterId) return false;
  if (opts.kinds !== undefined) {
    const kinds = new Set(Array.from(new Set(opts.kinds)).filter((kind) => kind.length > 0));
    if (kinds.size > 0 && !kinds.has(event.kind)) return false;
  }
  return true;
};

export const eventToRpc = (event: LedgerEvent): LedgerEventRpc => ({
  id: event.id,
  ts: event.ts,
  kind: event.kind,
  scopeRef: event.scopeRef,
  factOwnerRef: event.factOwnerRef,
  effectAuthorityRef: event.effectAuthorityRef,
  payload: event.payload,
});

export const projectionKeyFor = (
  identity: BackendProtocolEventIdentity,
  projectionKind: string,
  projectionId: string,
): BackendProtocolProjectionKey => ({
  ...identity,
  projectionKind,
  projectionId,
});

export const projectionRowKey = (
  identity: BackendProtocolEventIdentity,
  kind: string,
  projectionId: string,
): string => backendProtocolProjectionKey(projectionKeyFor(identity, kind, projectionId));

export const projectionMetaKey = (identity: BackendProtocolEventIdentity, kind: string): string =>
  backendProtocolProjectionKey(projectionKeyFor(identity, kind, "__meta__"));

export const cloneProjectionRows = (
  rows: ReadonlyMap<string, MaterializedProjectionRow>,
): Map<string, MaterializedProjectionRow> => new Map(rows);

export const cloneProjectionMeta = (
  meta: ReadonlyMap<string, InMemoryProjectionMeta>,
): Map<string, InMemoryProjectionMeta> => new Map(meta);

export const normalizeProjectionLimit = normalizeBackendPageLimit;
