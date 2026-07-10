import type { BoundaryModule } from "@agent-os/core/boundary-contract";
import {
  extensionOwnsEvent,
  isBoundaryModule,
  type ExtensionDeclaration,
} from "@agent-os/core/extensions";

export interface DeclaredBoundaryIntent {
  readonly kind: string;
  readonly boundaryOwnerId: string;
}

export type DeclaredBoundaryIntentBinding = DeclaredBoundaryIntent & {
  readonly boundaryModule: BoundaryModule;
};

export type DeclaredBoundaryIntentBindingResult =
  | {
      readonly ok: true;
      readonly bindings: ReadonlyArray<DeclaredBoundaryIntentBinding>;
    }
  | {
      readonly ok: false;
      readonly intent: DeclaredBoundaryIntent;
      readonly reason: "unbound_boundary_owner" | "event_outside_boundary";
    };

export const bindDeclaredBoundaryIntents = (
  extensions: ReadonlyArray<ExtensionDeclaration>,
  intents: ReadonlyArray<DeclaredBoundaryIntent>,
): DeclaredBoundaryIntentBindingResult => {
  const modules = new Map<string, BoundaryModule>();
  for (const extension of extensions) {
    if (isBoundaryModule(extension)) {
      modules.set(extension.manifest.ownerId, extension);
    }
  }

  const bindings: DeclaredBoundaryIntentBinding[] = [];
  for (const intent of intents) {
    const boundaryModule = modules.get(intent.boundaryOwnerId);
    if (boundaryModule === undefined) {
      return { ok: false, intent, reason: "unbound_boundary_owner" };
    }
    if (!extensionOwnsEvent(boundaryModule, intent.kind)) {
      return { ok: false, intent, reason: "event_outside_boundary" };
    }
    bindings.push({ ...intent, boundaryModule });
  }
  return { ok: true, bindings };
};
