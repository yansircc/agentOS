import { describe, it } from "vite-plus/test";
import type { BackendConformanceRegistrar } from "@agent-os/runtime/testing";
import { Effect } from "effect";

export const VITEST_BACKEND_CONFORMANCE_REGISTRAR: BackendConformanceRegistrar = {
  describe,
  law: (definition, effect) => {
    it(`${definition.id}: ${definition.title}`, () => Effect.runPromise(effect()));
  },
};
