import type { CapabilityLease } from "@agent-os/runtime";
import type {
  LedgerEventRpc,
  QuotaState,
  ResourceState,
  RunListPage,
  RunStatus,
  RunSummary,
  RunTrace,
} from "@agent-os/kernel/types";
import type { OpsErrorBody, ScopeSummary } from "@agent-os/ops-api";

export type OpsApiFetch = (request: Request) => Promise<Response>;

export interface MountOpsHtmxOptions {
  readonly apiFetch: OpsApiFetch;
  readonly uiBase?: string;
  readonly apiBase?: string;
  readonly title?: string;
  readonly htmxScriptSrc?: string | null;
  readonly runLimit?: number;
  readonly eventLimit?: number;
}

export interface NormalizedOpsHtmxOptions {
  readonly apiFetch: OpsApiFetch;
  readonly uiBase: string;
  readonly apiBase: string;
  readonly title: string;
  readonly htmxScriptSrc: string | null;
  readonly runLimit: number;
  readonly eventLimit: number;
}

export type ApiResult<T> =
  | { readonly ok: true; readonly status: number; readonly value: T }
  | {
      readonly ok: false;
      readonly status: number;
      readonly error: OpsErrorBody | { readonly error: string; readonly message: string };
    };

export interface ScopeListBody {
  readonly scopes: ReadonlyArray<ScopeSummary>;
}

export type {
  CapabilityLease,
  LedgerEventRpc,
  QuotaState,
  ResourceState,
  RunListPage,
  RunStatus,
  RunSummary,
  RunTrace,
  ScopeSummary,
};
