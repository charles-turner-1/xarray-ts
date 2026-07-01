/**
 * Shared public types for xarray-ts.
 *
 * @module
 */
import type * as zarr from "zarrita";

/** Any zarrita store we can read from (icechunk-js, FetchStore, an in-memory Map, ...). */
export type Store = zarr.Readable;

/** A zarrita array handle of unknown dtype, backed by any readable store. */
export type ZarrArray = zarr.Array<zarr.DataType, zarr.Readable>;

/** A zarrita group handle backed by any readable store. */
export type ZarrGroup = zarr.Group<zarr.Readable>;

/** Free-form attribute bag, mirroring a variable/group's zarr `attributes`. */
export type Attrs = zarr.Attributes;

/**
 * A Variable is the internal, dtype-erased representation of a single zarr array
 * reinterpreted with its xarray dimension names. Both coordinates and data
 * variables start life as a Variable.
 */
export interface Variable {
  /** Variable name (the array's node name within its group). */
  readonly name: string;
  /** Named dimensions, in array-axis order (from v3 `dimension_names`). */
  readonly dims: readonly string[];
  /** The variable's attributes. */
  readonly attrs: Attrs;
  /** Shape, in array-axis order. */
  readonly shape: readonly number[];
  /** Zarr data type, e.g. `"float32"`. */
  readonly dtype: zarr.DataType;
  /** Chunk shape, in array-axis order. */
  readonly chunks: readonly number[];
  /** The underlying lazy zarrita array handle. */
  readonly arr: ZarrArray;
}

/**
 * An eagerly-materialised coordinate. Coordinate arrays are small (typically
 * 1-D dimension labels) so we load and cache their values up front; time
 * coordinates are CF-decoded to epoch milliseconds.
 */
export interface Coord {
  readonly name: string;
  readonly dims: readonly string[];
  readonly attrs: Attrs;
  readonly dtype: zarr.DataType;
  /**
   * The loaded values. For time coordinates this is epoch-milliseconds when
   * {@link Coord.decoded} is `true`; otherwise the raw stored values.
   */
  readonly values: ReadonlyArray<number | bigint | string | boolean>;
  /** Whether this coordinate is a CF time axis (`units = "<unit> since <ref>"`). */
  readonly isTime: boolean;
  /**
   * For time coordinates, whether decoding succeeded. `false` means a
   * non-standard calendar was encountered and {@link Coord.values} are raw.
   */
  readonly decoded: boolean;
  /** Convenience: time values as `Date[]` (only when `isTime && decoded`). */
  dates(): Date[] | undefined;
}

/** A positional index along one dimension: an integer (drops the dim) or a half-open slice. */
export type IselIndexer = number | SliceArg;

/** A half-open slice `[start, stop)` with optional step. Omitted fields mean "to the end/beginning". */
export interface SliceArg {
  start?: number;
  stop?: number;
  step?: number;
}

/** Positional selection: a mapping of dimension name to an {@link IselIndexer}. */
export type IselSelection = Record<string, IselIndexer>;

/** A coordinate label used by `.sel`: a number, a `Date`/ISO string (time axes), bigint, boolean, or string. */
export type Label = number | bigint | string | boolean | Date;

/** A label range used by `.sel` (inclusive of both endpoints, mirroring xarray). */
export interface LabelSlice {
  start?: Label;
  stop?: Label;
}

/** Label-based selection: a mapping of dimension name to a {@link Label} or {@link LabelSlice}. */
export type SelSelection = Record<string, Label | LabelSlice>;

/** Options for label-based selection. */
export interface SelOptions {
  /**
   * How to resolve a scalar label that doesn't match exactly.
   * - `"exact"` (default): throw if the label is absent.
   * - `"nearest"`: pick the closest coordinate value (numeric/time coords only).
   */
  method?: "exact" | "nearest";
}

/** Options accepted by {@link openDataset}/{@link openZarr}. */
export interface OpenOptions {
  /** Group path within the store to open as a Dataset. Defaults to the root (`"/"`). */
  path?: string;
  /**
   * Explicit list of variable (array) names to load, used as a fallback when
   * the store has no consolidated metadata and cannot list its own children.
   */
  variables?: string[];
  /** Consolidated-metadata format(s) to try. Forwarded to zarrita. Defaults to `"v3"`. */
  consolidated?: zarr.ConsolidatedFormat | zarr.ConsolidatedFormat[];
}

/**
 * Forwarded options for `fromIcechunk`.
 *
 * Kept structurally typed so the root package declarations do not require the
 * optional `icechunk-js` peer to be installed just to resolve `xarray-ts`.
 */
export type FromIcechunkOptions = Record<string, unknown>;
