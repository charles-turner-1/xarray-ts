import { defineConfig } from "vitest/config";

/**
 * Opt-in differential tests: generate xarray-ts operation chains, emit the xarray
 * Python, and run it against *real* xarray to check the two agree (structure +
 * value spot-check). Needs a Python env with xarray/zarr — provided by pixi — so
 * this suite is excluded from the default `npm test` and run via
 * `pixi run test-differential`.
 */
export default defineConfig({
  test: {
    include: ["test/differential/**/*.test.ts"],
    environment: "node",
    // Property-based + a subprocess oracle: give it room beyond the default 5s.
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
