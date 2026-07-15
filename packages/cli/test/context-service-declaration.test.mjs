import assert from "node:assert/strict";
import test from "node:test";

import { contextServiceDeclarationFailures } from "../src/check/algorithmic/context-service-declaration.mjs";

void test("public Context services use declaration-stable function-style keys", () => {
  const sources = new Map([
    [
      "packages/core/src/service.ts",
      'export const Stable: Context.Service<Stable, Stable> = Context.Service<Stable, Stable>("stable");',
    ],
    [
      "packages/runtime/src/untyped.ts",
      'export const Untyped = Context.Service<Untyped, Untyped>("untyped");',
    ],
    [
      "packages/runtime/src/nested/service.ts",
      'export class Broken extends Context.Service<Broken, { readonly value: string }>()("broken") {}',
    ],
    [
      "tooling/example.ts",
      'export class HostOnly extends Context.Service<HostOnly, {}>()("host") {}',
    ],
  ]);

  assert.deepEqual(contextServiceDeclarationFailures(sources), [
    "packages/runtime/src/nested/service.ts: public Context services must use function-style Context.Service so canonical TypeScript 7 declarations preserve the service contract",
    "packages/runtime/src/untyped.ts: exported Context.Service values require an explicit Context.Service annotation so canonical TypeScript 7 declarations cannot widen to any",
  ]);
});
