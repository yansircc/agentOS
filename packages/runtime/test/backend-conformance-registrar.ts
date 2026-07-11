import { describe, it } from "@effect/vitest";
import type { BackendConformanceRegistrar } from "@agent-os/runtime/testing";

export const VITEST_BACKEND_CONFORMANCE_REGISTRAR: BackendConformanceRegistrar = {
  describe,
  law: (definition, effect) => {
    it.effect(`${definition.id}: ${definition.title}`, effect);
  },
};
