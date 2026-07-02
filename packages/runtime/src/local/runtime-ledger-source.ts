import { authorityRefKey, scopeRefKey } from "@agent-os/core/effect-claim";
import type { EventQueryOptions, LedgerEvent } from "@agent-os/core/types";
import {
  decodeRuntimeLedgerEvent,
  RUNTIME_FACT_OWNER,
  type LedgerTruthIdentity,
  type RuntimeLedgerEvent,
} from "@agent-os/core/runtime-protocol";
import type { TelemetryFanoutDiagnostic } from "@agent-os/core/telemetry-protocol";
import type { WorkspaceAgentInspectInputRequestCommandInput } from "@agent-os/core/workspace-agent";
import { validateBoundaryEventPayload, validateCommittedBoundaryEvent } from "../boundary-commit";
import { decisionGateBoundaryContract } from "../decision-gate";
import { projectInputRequestSettlement } from "../input-request";
import { projectRunInspection } from "../run-projector";

export interface LocalRuntimeLedgerSourceOptions {
  readonly events: ReadonlyArray<LedgerEvent> | (() => ReadonlyArray<LedgerEvent>);
  readonly diagnostics?:
    | ReadonlyArray<TelemetryFanoutDiagnostic>
    | (() => ReadonlyArray<TelemetryFanoutDiagnostic>);
}

export interface LocalRuntimeLedgerSource {
  readonly events: (opts?: EventQueryOptions) => ReadonlyArray<LedgerEvent>;
  readonly runtimeEvents: (opts?: EventQueryOptions) => ReadonlyArray<RuntimeLedgerEvent>;
  readonly inspectRun: (runId: number) => ReturnType<typeof projectRunInspection>;
  readonly inspectInputRequest: (
    input: WorkspaceAgentInspectInputRequestCommandInput,
  ) => ReturnType<typeof projectInputRequestSettlement>;
}

export class LocalRuntimeLedgerHydrationError extends Error {
  override readonly name = "LocalRuntimeLedgerHydrationError";
}

const decisionGateEventKinds = new Set<string>(Object.keys(decisionGateBoundaryContract.events));

const materializeEvents = (
  source: LocalRuntimeLedgerSourceOptions["events"],
): ReadonlyArray<LedgerEvent> => (typeof source === "function" ? source() : source);

const materializeDiagnostics = (
  source: LocalRuntimeLedgerSourceOptions["diagnostics"],
): ReadonlyArray<TelemetryFanoutDiagnostic> =>
  source === undefined ? [] : typeof source === "function" ? source() : source;

const optsMatch = (event: LedgerEvent, opts: EventQueryOptions): boolean => {
  if (opts.afterId !== undefined && event.id <= opts.afterId) return false;
  if (opts.kinds !== undefined && opts.kinds.length > 0 && !opts.kinds.includes(event.kind)) {
    return false;
  }
  if (
    opts.factOwnerRefs !== undefined &&
    opts.factOwnerRefs.length > 0 &&
    !opts.factOwnerRefs.includes(event.factOwnerRef)
  ) {
    return false;
  }
  if (opts.scopeRef !== undefined && scopeRefKey(opts.scopeRef) !== scopeRefKey(event.scopeRef)) {
    return false;
  }
  if (
    opts.effectAuthorityRef !== undefined &&
    authorityRefKey(opts.effectAuthorityRef) !== authorityRefKey(event.effectAuthorityRef)
  ) {
    return false;
  }
  return true;
};

const queryEvents = (
  events: ReadonlyArray<LedgerEvent>,
  opts: EventQueryOptions = {},
): ReadonlyArray<LedgerEvent> => {
  const limit = opts.limit === undefined ? undefined : Math.max(0, Math.trunc(opts.limit));
  const selected = events
    .filter((event) => optsMatch(event, opts))
    .sort((left, right) => left.id - right.id);
  return limit === undefined ? selected : selected.slice(0, limit);
};

const hydrationError = (message: string): LocalRuntimeLedgerHydrationError =>
  new LocalRuntimeLedgerHydrationError(message);

export const createLocalRuntimeLedgerSource = (
  options: LocalRuntimeLedgerSourceOptions,
): LocalRuntimeLedgerSource => ({
  events: (opts = {}) => queryEvents(materializeEvents(options.events), opts),
  runtimeEvents: (opts = {}) => {
    const decoded: RuntimeLedgerEvent[] = [];
    for (const event of queryEvents(materializeEvents(options.events), opts)) {
      const result = decodeRuntimeLedgerEvent(event);
      if (result._tag === "runtime") decoded.push(result.event);
    }
    return decoded;
  },
  inspectRun: (runId) =>
    projectRunInspection(queryEvents(materializeEvents(options.events)), runId, [
      ...materializeDiagnostics(options.diagnostics),
    ]),
  inspectInputRequest: (input) =>
    projectInputRequestSettlement(queryEvents(materializeEvents(options.events)), input.ref),
});

const objectPayload = (
  event: LedgerEvent,
):
  | { readonly ok: true; readonly payload: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly error: LocalRuntimeLedgerHydrationError } => {
  if (
    typeof event.payload === "object" &&
    event.payload !== null &&
    !Array.isArray(event.payload)
  ) {
    return { ok: true, payload: event.payload as Readonly<Record<string, unknown>> };
  }
  return {
    ok: false,
    error: hydrationError(
      `local runtime ledger hydrate rejected non-object payload for ${event.kind}`,
    ),
  };
};

const validateTruthIdentity = (
  event: LedgerEvent,
  identity: LedgerTruthIdentity,
): LocalRuntimeLedgerHydrationError | null => {
  if (scopeRefKey(event.scopeRef) !== scopeRefKey(identity.scopeRef)) {
    return hydrationError(`local runtime ledger hydrate scope mismatch at event ${event.id}`);
  }
  if (authorityRefKey(event.effectAuthorityRef) !== authorityRefKey(identity.effectAuthorityRef)) {
    return hydrationError(`local runtime ledger hydrate authority mismatch at event ${event.id}`);
  }
  return null;
};

const validateDecisionGateEvent = (
  event: LedgerEvent,
):
  | { readonly owned: false }
  | { readonly owned: true; readonly error: LocalRuntimeLedgerHydrationError | null } => {
  if (!decisionGateEventKinds.has(event.kind)) return { owned: false };
  const payload = objectPayload(event);
  if (!payload.ok) return { owned: true, error: payload.error };
  const payloadRejected = validateBoundaryEventPayload(
    decisionGateBoundaryContract,
    event.kind,
    payload.payload,
  );
  if (payloadRejected !== null) {
    return {
      owned: true,
      error: hydrationError(
        `local runtime ledger hydrate rejected decision gate payload at event ${event.id}: ${payloadRejected.issue}`,
      ),
    };
  }
  const committedRejected = validateCommittedBoundaryEvent(
    decisionGateBoundaryContract,
    event.kind,
    payload.payload,
    event,
  );
  if (committedRejected !== null) {
    return {
      owned: true,
      error: hydrationError(
        `local runtime ledger hydrate rejected decision gate identity at event ${event.id}: ${committedRejected.issue}`,
      ),
    };
  }
  return { owned: true, error: null };
};

export const validateLocalRuntimeLedgerHydrationEvents = (
  events: ReadonlyArray<LedgerEvent>,
  identity: LedgerTruthIdentity,
): LocalRuntimeLedgerHydrationError | null => {
  for (const [index, event] of events.entries()) {
    const expectedId = index + 1;
    if (event.id !== expectedId) {
      return hydrationError(
        `local runtime ledger hydrate requires contiguous events starting at 1; expected ${expectedId}, got ${event.id}`,
      );
    }
    const identityError = validateTruthIdentity(event, identity);
    if (identityError !== null) return identityError;
    const runtime = decodeRuntimeLedgerEvent(event);
    if (runtime._tag === "runtime") {
      if (event.factOwnerRef !== RUNTIME_FACT_OWNER) {
        return hydrationError(
          `local runtime ledger hydrate rejected runtime fact owner at event ${event.id}`,
        );
      }
      continue;
    }
    const decisionGate = validateDecisionGateEvent(event);
    if (decisionGate.owned) return decisionGate.error;
    return hydrationError(`local runtime ledger hydrate does not own event kind ${event.kind}`);
  }
  return null;
};
