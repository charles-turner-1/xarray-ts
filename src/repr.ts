/**
 * Node `util.inspect` formatting helpers shared by {@link DataArray} and
 * {@link Dataset}.
 *
 * These only reference the well-known custom-inspect symbol (looked up by
 * string), never `node:util`, so the bundle stays browser-safe: browsers never
 * consult the symbol and this becomes dead code there.
 *
 * @module
 */

/** Symbol Node's `util.inspect`/`console.log` looks up to let a class render itself. */
export const INSPECT = Symbol.for("nodejs.util.inspect.custom");

/** Colouriser Node passes in `options.stylize`; the identity function when colours are off. */
export type Stylize = (text: string, style: string) => string;

/** The subset of Node's inspect `options` we rely on. */
export interface InspectOptions {
  stylize: Stylize;
  depth: number | null;
  [key: string]: unknown;
}

/** Node's recursive formatter, handed to a custom inspector as its third argument. */
export type InspectFn = (value: unknown, options: InspectOptions) => string;

/** `(lat: 100, lon: 200)` — or `()` for a scalar. */
export function formatDims(dims: readonly string[], shape: readonly number[]): string {
  return `(${dims.map((d, i) => `${d}: ${shape[i]}`).join(", ")})`;
}

/** `(time, lat, lon)` — just the dimension names, xarray-style. */
export function formatDimNames(dims: readonly string[]): string {
  return `(${dims.join(", ")})`;
}
