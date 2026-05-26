# Package Patches

`@effect%2Fvitest@0.29.0.patch` changes only package metadata: it broadens
`@effect/vitest`'s `vitest` peer range from `^3.2.0` to
`^3.2.0 || ^4.0.0`.

Failure model: `@cloudflare/vitest-pool-workers@0.16.9` requires Vitest 4, while
the current `@effect/vitest@0.29.0` package metadata still declares only Vitest
3. The test runtime is verified against Vitest 4.1.7.

Removal condition: delete this patch when `@effect/vitest` publishes a version
whose `vitest` peer range includes Vitest 4.
