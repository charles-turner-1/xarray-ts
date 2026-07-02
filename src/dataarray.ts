/**
 * {@link DataArray}: a lazy, named N-D array view over a single zarr variable.
 *
 * Metadata (dims, shape, attrs, coords) is synchronous. Pulling actual values
 * is asynchronous and streams only the selected slice via `zarrita.get`.
 *
 * @module
 */
import * as zarr from "zarrita";
import { applyIndexer, axisToZarr, fullAxis, sliceCoord, type AxisSel } from "./axis.js";
import { renameCoord } from "./coords.js";
import { isLabelSlice, lookupLabel, lookupLabelSlice, toSliceArg } from "./indexing.js";
import { INSPECT, formatDims, type InspectFn, type InspectOptions } from "./repr.js";
import type { Coord, IselSelection, SelOptions, SelSelection, Variable } from "./types.js";

/** Materialised slice data plus its shape/strides, as returned by `zarrita.get`. */
export type Chunk = zarr.Chunk<zarr.DataType>;
/** A single scalar value (returned when every dimension is integer-indexed). */
export type Scalar = zarr.Scalar<zarr.DataType>;

export class DataArray {
  /** @internal The underlying variable (metadata + lazy zarrita handle). */
  readonly variable: Variable;
  /** @internal Per-original-axis selection, aligned to `variable.dims`. */
  readonly #axes: AxisSel[];
  /** @internal All coordinates available from the parent Dataset (full, unsliced). */
  readonly #coords: ReadonlyMap<string, Coord>;

  constructor(variable: Variable, coords: ReadonlyMap<string, Coord>, axes?: AxisSel[]) {
    this.variable = variable;
    this.#coords = coords;
    this.#axes = axes ?? variable.shape.map(fullAxis);
  }

  /** The variable's name. */
  get name(): string {
    return this.variable.name;
  }

  /** Remaining dimensions after the current selection (integer-indexed dims are dropped). */
  get dims(): string[] {
    return this.variable.dims.filter((_, i) => this.#axes[i]!.kind === "slice");
  }

  /** Shape of the current selection, aligned to {@link DataArray.dims}. */
  get shape(): number[] {
    const out: number[] = [];
    for (const axis of this.#axes) if (axis.kind === "slice") out.push(axis.length);
    return out;
  }

  /** The variable's attributes. */
  get attrs(): Variable["attrs"] {
    return this.variable.attrs;
  }

  /** The variable's zarr data type. */
  get dtype(): zarr.DataType {
    return this.variable.dtype;
  }

  /**
   * Coordinates relevant to this array, sliced to the current selection.
   *
   * Includes 1-D coordinates for the array's dimensions (sliced), and scalar
   * coordinates for dimensions that have been integer-indexed away. Multi-
   * dimensional auxiliary coordinates are omitted in this version.
   */
  get coords(): Record<string, Coord> {
    const out: Record<string, Coord> = {};
    for (const [name, coord] of this.#coords) {
      if (coord.dims.length !== 1) continue;
      const axisIndex = this.variable.dims.indexOf(coord.dims[0]!);
      if (axisIndex === -1) continue;
      out[name] = sliceCoord(coord, this.#axes[axisIndex]!);
    }
    return out;
  }

  /** Rename the array itself (xarray `DataArray.rename("new_name")`). */
  rename(name: string): DataArray;
  /**
   * Rename this array's dimensions and/or coordinates (xarray
   * `DataArray.rename({ old: new })`). Pure relabel — the selection is
   * unchanged, no data is read.
   */
  rename(names: Record<string, string>): DataArray;
  rename(arg: string | Record<string, string>): DataArray {
    if (typeof arg === "string") {
      return new DataArray({ ...this.variable, name: arg }, this.#coords, this.#axes);
    }

    for (const key of Object.keys(arg)) {
      const isDim = this.variable.dims.includes(key);
      const isCoord = this.#coords.has(key);
      if (!isDim && !isCoord) {
        throw new Error(
          `xarray-ts: "${this.name}" has no dimension or coordinate "${key}" to rename.`,
        );
      }
    }

    const variable: Variable = {
      ...this.variable,
      name: arg[this.name] ?? this.name,
      dims: this.variable.dims.map((dim) => arg[dim] ?? dim),
    };
    const coords = new Map<string, Coord>();
    for (const [name, coord] of this.#coords) {
      coords.set(arg[name] ?? name, renameCoord(coord, arg[name] ?? name, arg));
    }
    return new DataArray(variable, coords, this.#axes);
  }

  /** Positional selection (xarray `.isel`). Returns a new lazy view. */
  isel(selection: IselSelection): DataArray {
    const axes = this.#axes.slice();
    for (const [dim, indexer] of Object.entries(selection)) {
      const axisIndex = this.#requireDim(dim);
      axes[axisIndex] = applyIndexer(axes[axisIndex]!, indexer, dim);
    }
    return new DataArray(this.variable, this.#coords, axes);
  }

  /** Label-based selection (xarray `.sel`). Resolves labels via coordinates, then delegates to `isel`. */
  sel(selection: SelSelection, opts: SelOptions = {}): DataArray {
    const positional: IselSelection = {};
    const sliced = this.coords;
    for (const [dim, label] of Object.entries(selection)) {
      const coord = sliced[dim];
      if (!coord) {
        throw new Error(`xarray-ts: no coordinate named "${dim}" to select by label.`);
      }
      positional[dim] = isLabelSlice(label)
        ? toSliceArg(lookupLabelSlice(coord, label))
        : lookupLabel(coord, label, opts);
    }
    return this.isel(positional);
  }

  /** Stream the current selection and return the materialised chunk (or scalar). */
  async load(opts?: zarr.GetOptions): Promise<Chunk | Scalar> {
    const selection = this.#axes.map((axis, i) => axisToZarr(axis, this.variable.shape[i]!));
    return (await zarr.get(this.variable.arr, selection, opts)) as Chunk | Scalar;
  }

  /** Convenience: like {@link DataArray.load} but returns just the values (TypedArray or scalar). */
  async values(opts?: zarr.GetOptions): Promise<Chunk["data"] | Scalar> {
    const result = await this.load(opts);
    return isChunk(result) ? result.data : result;
  }

  /**
   * Node `util.inspect` hook (`console.log`): a compact, xarray-style summary of
   * the current view — dims with sizes, dtype, chunks and attrs — without
   * touching the lazy data. Ignored by browser consoles.
   */
  [INSPECT](_depth: number, options: InspectOptions, inspect: InspectFn): string {
    const { stylize } = options;
    const header =
      `${stylize("DataArray", "special")} ${stylize(`'${this.name}'`, "string")} ` +
      `${formatDims(this.dims, this.shape)} ${stylize(this.dtype, "special")}`;

    const lines: string[] = [];
    // Chunk sizes for the axes still present in the current view, aligned to `dims`.
    const chunks = this.dims.map((dim) => this.variable.chunks[this.variable.dims.indexOf(dim)]);
    if (chunks.length) {
      lines.push(`chunks: (${chunks.join(", ")})`);
    }
    if (Object.keys(this.attrs).length) {
      lines.push(`attrs:  ${inspect(this.attrs, options)}`);
    }
    return lines.length ? `${header}\n${lines.map((l) => `  ${l}`).join("\n")}` : header;
  }

  /** @internal Validate that a dimension exists in the current view. */
  #requireDim(dim: string): number {
    const i = this.variable.dims.indexOf(dim);
    if (i === -1) {
      throw new Error(
        `xarray-ts: "${this.name}" has no dimension "${dim}" ` +
          `(dims: ${JSON.stringify(this.variable.dims)}).`,
      );
    }
    return i;
  }
}

function isChunk(value: Chunk | Scalar): value is Chunk {
  return typeof value === "object" && value !== null && "data" in value && "shape" in value;
}
