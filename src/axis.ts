/**
 * Per-axis selection state and the arithmetic to compose selections.
 *
 * An axis is either an integer index (which drops the dimension) or a strided
 * slice. Selections are stored resolved against the *original* array axes so
 * that chained `isel`/`sel` calls compose correctly.
 *
 * @module
 */
import type * as zarr from "zarrita";
import { resolveSlice, toZarrSlice } from "./indexing.js";
import type { Coord, IselIndexer } from "./types.js";

/** A resolved per-axis selection. */
export type AxisSel =
  | { kind: "int"; index: number }
  | { kind: "slice"; start: number; step: number; length: number };

/** The identity selection for an axis of the given size (keeps the whole axis). */
export function fullAxis(size: number): AxisSel {
  return { kind: "slice", start: 0, step: 1, length: size };
}

/** Compose an integer index (relative to the current view) onto a slice axis. */
export function composeInt(axis: Extract<AxisSel, { kind: "slice" }>, index: number): AxisSel {
  const i = index < 0 ? index + axis.length : index;
  if (i < 0 || i >= axis.length) {
    throw new Error(`xarray-ts: index ${index} is out of bounds for length ${axis.length}.`);
  }
  return { kind: "int", index: axis.start + i * axis.step };
}

/** Compose an inner slice (relative to the current view) onto a slice axis. */
export function composeSlice(
  axis: Extract<AxisSel, { kind: "slice" }>,
  arg: Exclude<IselIndexer, number>,
): AxisSel {
  const inner = resolveSlice(toZarrSlice(arg), axis.length);
  return {
    kind: "slice",
    start: axis.start + inner.start * axis.step,
    step: axis.step * inner.step,
    length: inner.length,
  };
}

/** Apply one indexer to a slice axis (throws if the axis was already indexed out). */
export function applyIndexer(axis: AxisSel, indexer: IselIndexer, dim: string): AxisSel {
  if (axis.kind !== "slice") {
    throw new Error(`xarray-ts: dimension "${dim}" has already been indexed out.`);
  }
  return typeof indexer === "number" ? composeInt(axis, indexer) : composeSlice(axis, indexer);
}

/** Convert an axis selection to a zarrita selection entry (`null` for a whole axis). */
export function axisToZarr(axis: AxisSel, size: number): number | zarr.Slice | null {
  if (axis.kind === "int") return axis.index;
  const isFull = axis.start === 0 && axis.step === 1 && axis.length === size;
  if (isFull) return null;
  const stop = axis.start + axis.length * axis.step;
  return { start: axis.start, stop: stop < 0 ? null : stop, step: axis.step };
}

/** Slice an in-memory coordinate's values to match an axis selection. */
export function sliceCoord(coord: Coord, axis: AxisSel): Coord {
  const all = coord.values;
  if (axis.kind === "int") {
    return { ...coord, dims: [], values: [all[axis.index]!] };
  }
  const values: Array<number | bigint | string | boolean> = [];
  for (let i = 0; i < axis.length; i++) values.push(all[axis.start + i * axis.step]!);
  return { ...coord, values };
}
