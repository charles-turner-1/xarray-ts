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
import { isLazyCoord, renameCoord, renameLazyCoord } from "./coords.js";
import { isLabelSlice, lookupLabel, lookupLabelSlice, toSliceArg } from "./indexing.js";
import { INSPECT, formatDims, type InspectFn, type InspectOptions } from "./repr.js";
import type { AnyCoord, IselSelection, SelOptions, SelSelection, Variable } from "./types.js";

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
  readonly #coords: ReadonlyMap<string, AnyCoord>;

  constructor(variable: Variable, coords: ReadonlyMap<string, AnyCoord>, axes?: AxisSel[]) {
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
   * Coordinates relevant to this array — every coordinate whose dimensions are a
   * subset of the array's dimensions (mirroring xarray).
   *
   * Dimension coordinates are eager {@link Coord}s, sliced to the current
   * selection (an integer-indexed dimension collapses its coordinate to a
   * scalar); auxiliary / scalar / N-d coordinates surface as lazy
   * {@link LazyCoord}s. N-d coordinates are returned unsliced — propagating a
   * partial selection through them is future work.
   */
  get coords(): Record<string, AnyCoord> {
    const out: Record<string, AnyCoord> = {};
    for (const [name, coord] of this.#coords) {
      if (!coord.dims.every((dim) => this.variable.dims.includes(dim))) continue;
      if (isLazyCoord(coord)) {
        out[name] = coord;
      } else if (coord.dims.length === 1) {
        out[name] = sliceCoord(coord, this.#axes[this.variable.dims.indexOf(coord.dims[0]!)]!);
      } else {
        out[name] = coord;
      }
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
    const coords = new Map<string, AnyCoord>();
    for (const [name, coord] of this.#coords) {
      const newName = arg[name] ?? name;
      coords.set(
        newName,
        isLazyCoord(coord)
          ? renameLazyCoord(coord, newName, arg)
          : renameCoord(coord, newName, arg),
      );
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

  /**
   * Drop dimensions of size 1 (xarray `DataArray.squeeze`). With no argument,
   * drops every size-1 dimension; with `dim`, drops only those (erroring if a
   * named dimension is not size 1). A dropped dimension coordinate is retained
   * as a scalar coordinate. Metadata-only — no data is read.
   */
  squeeze(dim?: string | string[]): DataArray {
    const size = new Map(this.dims.map((d, i) => [d, this.shape[i]!]));
    const targets =
      dim === undefined
        ? [...size].filter(([, s]) => s === 1).map(([d]) => d)
        : typeof dim === "string"
          ? [dim]
          : dim;
    for (const d of targets) {
      if (!size.has(d)) {
        throw new Error(
          `xarray-ts: "${this.name}" has no dimension "${d}" (dims: ${JSON.stringify(this.dims)}).`,
        );
      }
      if (size.get(d) !== 1) {
        throw new Error(
          `xarray-ts: cannot squeeze dimension "${d}" of size ${size.get(d)} (must be 1).`,
        );
      }
    }
    return this.isel(Object.fromEntries(targets.map((d) => [d, 0])));
  }

  /**
   * Swap a dimension for a 1-D coordinate defined along it (xarray
   * `DataArray.swap_dims`).
   *
   * For `{ x: "lon" }`, dimension `x` is replaced by `lon`: `lon` (which must be
   * an existing 1-D coordinate of this array along `x`) becomes the new dimension
   * coordinate, the old `x` coordinate is kept as a non-dimension coordinate
   * along `lon`, and the array's dims are relabelled. Pure metadata — no data is
   * read; a prior `isel`/`sel` selection carries over.
   *
   * The replacement is a 1-D *auxiliary* coordinate, which is lazy, so the new
   * dimension coordinate surfaces lazily; label-based `.sel()` along it requires
   * an eager dimension coordinate (use `isel` instead).
   */
  swapDims(dims: Record<string, string>): DataArray {
    const currentDims = this.dims;
    const seen = new Set<string>();
    for (const [oldDim, newName] of Object.entries(dims)) {
      if (!currentDims.includes(oldDim)) {
        throw new Error(
          `xarray-ts: cannot swap from dimension "${oldDim}" — it is not a dimension of "${this.name}".`,
        );
      }
      if (oldDim !== newName && currentDims.includes(newName)) {
        throw new Error(
          `xarray-ts: cannot swap dimension "${oldDim}" to existing dimension "${newName}".`,
        );
      }
      if (seen.has(newName)) {
        throw new Error(`xarray-ts: cannot swap multiple dimensions to "${newName}".`);
      }
      seen.add(newName);
      const coord = this.#coords.get(newName);
      if (!coord || !(coord.dims.length === 1 && coord.dims[0] === oldDim)) {
        throw new Error(
          `xarray-ts: replacement dimension "${newName}" is not a 1-D coordinate along "${oldDim}".`,
        );
      }
    }

    const variable: Variable = {
      ...this.variable,
      dims: this.variable.dims.map((dim) => dims[dim] ?? dim),
    };
    const coords = new Map<string, AnyCoord>();
    for (const [name, coord] of this.#coords) {
      coords.set(
        name,
        isLazyCoord(coord) ? renameLazyCoord(coord, name, dims) : renameCoord(coord, name, dims),
      );
    }
    return new DataArray(variable, coords, this.#axes);
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
      if (isLazyCoord(coord)) {
        throw new Error(
          `xarray-ts: cannot select by "${dim}" — label selection requires an eager ` +
            `dimension coordinate (auxiliary coordinates are lazy; use \`isel\` instead).`,
        );
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
