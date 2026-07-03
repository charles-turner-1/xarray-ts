/**
 * The runtime that powers the interactive code cells in the docs.
 *
 * It re-exports the full public API from the local library source (so examples
 * always track the real `src/`, never a stale published build) plus the
 * hermetic in-memory demo stores from the test fixtures. Everything here runs
 * entirely in the browser: the stores are plain `Map`s built with zarrita, so
 * every example is fully offline — no server, no network, no real data.
 */
export * from "../../src/index.ts";

export {
  makeDemoStore,
  makeSqueezeStore,
  makeSwapDimsStore,
  makeAuxDimCoordStore,
  makeScalarCoordStore,
  makeAuxCoordStore,
} from "../../test/fixtures.ts";
