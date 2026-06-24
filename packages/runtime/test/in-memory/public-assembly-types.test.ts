import { describe, expect, it } from "@effect/vitest";
import { createInMemoryRuntimeBackend } from "../../src/in-memory";
import { truthIdentity } from "./identity";

describe("in-memory public assembly types", () => {
  it("keeps createInMemoryRuntimeBackend as a graph-only public boundary", () => {
    expect(typeof createInMemoryRuntimeBackend).toBe("function");
  });
});

const looseHalfRegistrationShape = {
  identity: truthIdentity("half-registration"),
  projections: [],
};

if (false) {
  // @ts-expect-error public in-memory assembly requires resolver-owned graph brand
  createInMemoryRuntimeBackend(looseHalfRegistrationShape);

  // @ts-expect-error public in-memory subpath must not export raw backend state construction
  type _RawStateConstructor = typeof import("../../src/in-memory").createInMemoryBackendState;

  // @ts-expect-error public local subpath must not expose a second workspace-op provider path
  type _LocalWorkspaceOpProvider = typeof import("../../src/local/index").installLocalWorkspaceOperationProvider;
}
