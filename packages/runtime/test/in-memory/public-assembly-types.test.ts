import { describe, expect, it } from "@effect/vitest";
import { createInMemoryRuntimeBackend } from "../../src/in-memory";
import { truthIdentity } from "./identity";

// @ts-expect-error public in-memory subpath must not export raw backend state construction
import type { createInMemoryBackendState } from "../../src/in-memory";

// @ts-expect-error public local subpath must not expose a second workspace-op provider path
import type { installLocalWorkspaceOperationProvider } from "../../src/local/index";

describe("in-memory public assembly types", () => {
  it("keeps createInMemoryRuntimeBackend as a graph-only public boundary", () => {
    expect(typeof createInMemoryRuntimeBackend).toBe("function");
  });
});

const looseHalfRegistrationShape = {
  identity: truthIdentity("half-registration"),
  projections: [],
};

const assertPublicAssemblyTypes = (): void => {
  // @ts-expect-error public in-memory assembly requires resolver-owned graph brand
  createInMemoryRuntimeBackend(looseHalfRegistrationShape);

  type _RawStateConstructor = typeof createInMemoryBackendState;
  type _LocalWorkspaceOpProvider = typeof installLocalWorkspaceOperationProvider;
  void (undefined as unknown as [_RawStateConstructor, _LocalWorkspaceOpProvider]);
};

void assertPublicAssemblyTypes;
