/**
 * {@link Dataset}: a collection of {@link DataArray}s sharing dimensions and
 * coordinates — the xarray-shaped object produced by {@link openDataset}.
 *
 * @module
 */
import { applyIndexer, fullAxis, sliceCoord, type AxisSel } from "./axis.js";
import { isDimensionCoord, isLazyCoord, makeLazyCoord, renameCoord } from "./coords.js";
import { DataArray } from "./dataarray.js";
import { isLabelSlice, lookupLabel, lookupLabelSlice, toSliceArg } from "./indexing.js";
import { INSPECT, formatDimNames, type InspectFn, type InspectOptions } from "./repr.js";
import type {
  AnyCoord,
  Attrs,
  Coord,
  IselSelection,
  SelOptions,
  SelSelection,
  Variable,
} from "./types.js";

/** Internal assembly input for a Dataset (built by `datasetFromGroup`). */
export interface DatasetParts {
  /** All variables (coordinates and data variables) keyed by name. */
  vars: Map<string, Variable>;
  /** Eagerly-loaded coordinate values keyed by name. */
  coords: Map<string, Coord>;
  /** Names classified as coordinates. */
  coordNames: Set<string>;
  /** Names classified as data variables. */
  dataVarNames: Set<string>;
  /** Group-level attributes. */
  attrs: Attrs;
}

export class Dataset {
  /** Group-level attributes. */
  readonly attrs: Attrs;

  /** @internal All variables (coords + data vars). */
  readonly #vars: Map<string, Variable>;
  /** @internal Root (full, unsliced) coordinates — what DataArrays slice against. */
  readonly #rootCoords: Map<string, Coord>;
  readonly #coordNames: Set<string>;
  readonly #dataVarNames: Set<string>;
  /** @internal Original size of each dimension. */
  readonly #dimSizes: Map<string, number>;
  /** @internal Cumulative selection per dimension (relative to original axes). */
  readonly #axesByDim: Map<string, AxisSel>;

  constructor(parts: DatasetParts, axesByDim?: Map<string, AxisSel>) {
    this.attrs = parts.attrs;
    this.#vars = parts.vars;
    this.#rootCoords = parts.coords;
    this.#coordNames = parts.coordNames;
    this.#dataVarNames = parts.dataVarNames;
    this.#dimSizes = computeDimSizes(parts.vars);
    this.#axesByDim =
      axesByDim ?? new Map([...this.#dimSizes].map(([dim, size]) => [dim, fullAxis(size)]));
  }

  /** Mapping of dimension name to its current size. */
  get dims(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [dim, axis] of this.#axesByDim) {
      if (axis.kind === "slice") out[dim] = axis.length;
    }
    return out;
  }

  /**
   * Coordinates for the current selection (presentational). Dimension
   * coordinates are eager {@link Coord}s, sliced to the selection; auxiliary /
   * scalar / N-d coordinates are lazy {@link LazyCoord}s (values on `await`).
   */
  get coords(): Record<string, AnyCoord> {
    const out: Record<string, AnyCoord> = {};
    for (const name of this.#coordNames) {
      const eager = this.#rootCoords.get(name);
      out[name] = eager
        ? sliceCoord(eager, this.#axisFor(eager.dims[0]!))
        : makeLazyCoord(this.#vars.get(name)!);
    }
    return out;
  }

  /** Data variables as lazy {@link DataArray}s, reflecting the current selection. */
  get data_vars(): Record<string, DataArray> {
    const out: Record<string, DataArray> = {};
    for (const name of this.#dataVarNames) out[name] = this.#dataArray(name);
    return out;
  }

  /**
   * All variables — coordinates and data variables — as lazy {@link DataArray}s,
   * keyed by name and reflecting the current selection (xarray `Dataset.variables`).
   */
  get variables(): Record<string, DataArray> {
    const out: Record<string, DataArray> = {};
    for (const name of this.#vars.keys()) out[name] = this.#dataArray(name);
    return out;
  }

  /** Get any variable (coordinate or data variable) as a lazy {@link DataArray}. */
  get(name: string): DataArray {
    if (!this.#vars.has(name)) {
      throw new Error(`xarray-ts: no variable named "${name}" in Dataset.`);
    }
    return this.#dataArray(name);
  }

  /**
   * Rename variables, coordinates and/or dimensions in one call (xarray
   * `Dataset.rename`), without touching underlying data values.
   *
   * Each key is dispatched by what it names: a variable/coordinate renames the
   * variable; a dimension renames the dimension across every variable; a
   * dimension coordinate (a name that is both) renames both, keeping `.sel()`
   * and `ds.coords` aligned. A key that is neither is an error.
   */
  rename(names: Record<string, string>): Dataset {
    const varRenames: Record<string, string> = {};
    const dimRenames: Record<string, string> = {};
    for (const [oldName, newName] of Object.entries(names)) {
      const isVar = this.#vars.has(oldName);
      const isDim = this.#dimSizes.has(oldName);
      if (!isVar && !isDim) {
        throw new Error(
          `xarray-ts: cannot rename "${oldName}" — not a variable or dimension in this Dataset.`,
        );
      }
      if (isVar) varRenames[oldName] = newName;
      if (isDim) dimRenames[oldName] = newName;
    }
    return this.#renamed(varRenames, dimRenames);
  }

  /** Rename variables/coordinates without touching underlying data values. */
  renameVars(names: Record<string, string>): Dataset {
    return this.#renamed(names, {});
  }

  /**
   * Rename dimensions; if a dimension coordinate shares the old dimension name,
   * rename that coordinate variable too so `.sel()` and `ds.coords` stay aligned.
   */
  renameDims(names: Record<string, string>): Dataset {
    const varRenames: Record<string, string> = {};
    for (const [oldDim, newDim] of Object.entries(names)) {
      if (this.#coordNames.has(oldDim)) varRenames[oldDim] = newDim;
    }
    return this.#renamed(varRenames, names);
  }

  /**
   * Drop variables/coordinates by name, returning a new Dataset with the
   * remaining structure unchanged and data variables still lazy.
   */
  dropVars(names: Iterable<string>): Dataset {
    const drop = this.#validatedNames(names);
    const keep = new Set<string>();
    for (const name of this.#vars.keys()) {
      if (!drop.has(name)) keep.add(name);
    }
    return this.#subset(keep);
  }

  /**
   * Keep only the named variables, plus every coordinate whose dimensions are a
   * subset of the picked variables' dimensions (xarray `Dataset[[names]]`).
   *
   * This keeps dimension coordinates for retained dims, scalar coordinates
   * (empty dims, a subset of anything), and N-d auxiliary coordinates defined
   * on retained dims — while never resurrecting a dimension that was dropped.
   */
  pickVars(names: Iterable<string>): Dataset {
    const keep = this.#validatedNames(names);

    const neededDims = new Set<string>();
    for (const name of keep) {
      for (const dim of this.#vars.get(name)!.dims) neededDims.add(dim);
    }

    for (const name of this.#coordNames) {
      if (keep.has(name)) continue;
      if (this.#vars.get(name)!.dims.every((dim) => neededDims.has(dim))) {
        keep.add(name);
      }
    }

    return this.#subset(keep);
  }

  /**
   * Promote data variables to coordinates (xarray `Dataset.set_coords`).
   *
   * Pure metadata reclassification — no data is read. A promoted variable
   * becomes an auxiliary (lazy) coordinate; its values load on demand via
   * `coords[name].load()`. Idempotent (promoting an existing coordinate is a
   * no-op). Note it never eagerly materialises: if you promote a
   * dimension-shaped variable and need it loaded for `.sel()`, that is the
   * eager-open path.
   */
  setCoords(names: string | Iterable<string>): Dataset {
    const promote = this.#validatedNames(typeof names === "string" ? [names] : names);
    const coordNames = new Set(this.#coordNames);
    const dataVarNames = new Set(this.#dataVarNames);
    for (const name of promote) {
      coordNames.add(name);
      dataVarNames.delete(name);
    }
    return this.#reclassified(coordNames, dataVarNames);
  }

  /**
   * Reset coordinates back to data variables (xarray `Dataset.reset_coords`).
   *
   * With no argument, resets every non-dimension coordinate. Dimension (index)
   * coordinates cannot be reset — pass `renameDims`/`isel` semantics instead.
   * With `{ drop: true }`, the coordinates are removed entirely rather than
   * demoted to data variables.
   */
  resetCoords(names?: string | Iterable<string>, opts: { drop?: boolean } = {}): Dataset {
    const dimCoords = this.#dimensionCoordNames();
    let reset: Set<string>;
    if (names === undefined) {
      reset = new Set([...this.#coordNames].filter((name) => !dimCoords.has(name)));
    } else {
      reset = this.#validatedNames(typeof names === "string" ? [names] : names);
      const bad = [...reset].filter((name) => dimCoords.has(name));
      if (bad.length) {
        throw new Error(
          `xarray-ts: cannot reset index (dimension) coordinates: ${JSON.stringify(bad)}.`,
        );
      }
    }

    const coordNames = new Set(this.#coordNames);
    const dataVarNames = new Set(this.#dataVarNames);
    const vars = opts.drop ? new Map(this.#vars) : this.#vars;
    for (const name of reset) {
      coordNames.delete(name);
      if (opts.drop) {
        vars.delete(name);
        dataVarNames.delete(name);
      } else {
        dataVarNames.add(name);
      }
    }
    return this.#reclassified(coordNames, dataVarNames, vars);
  }

  /**
   * Swap dimension(s) for 1-D variables defined along them (xarray
   * `Dataset.swap_dims`).
   *
   * For `{ x: "lon" }`, dimension `x` is replaced by `lon` everywhere: `lon`
   * (which must be a 1-D variable along `x`) becomes the new dimension
   * coordinate, the old `x` coordinate is kept as a non-dimension coordinate
   * along `lon`, and every variable's dims are relabelled. Pure metadata — no
   * data is read; a prior `isel`/`sel` selection carries over.
   *
   * A swapped-in coordinate that was not eagerly loaded at open surfaces as a
   * lazy coordinate. As elsewhere, label-based `.sel()` along it requires an
   * eager dimension coordinate (the same limitation noted on {@link Dataset.setCoords}).
   */
  swapDims(dims: Record<string, string>): Dataset {
    const currentDims = this.dims;
    const seen = new Set<string>();
    for (const [oldDim, newName] of Object.entries(dims)) {
      if (!(oldDim in currentDims)) {
        throw new Error(
          `xarray-ts: cannot swap from dimension "${oldDim}" — it is not a dimension of this Dataset.`,
        );
      }
      if (oldDim !== newName && newName in currentDims) {
        throw new Error(
          `xarray-ts: cannot swap dimension "${oldDim}" to existing dimension "${newName}".`,
        );
      }
      if (seen.has(newName)) {
        throw new Error(`xarray-ts: cannot swap multiple dimensions to "${newName}".`);
      }
      seen.add(newName);
      const v = this.#vars.get(newName);
      if (v && !(v.dims.length === 1 && v.dims[0] === oldDim)) {
        throw new Error(
          `xarray-ts: replacement dimension "${newName}" is not a 1-D variable along "${oldDim}".`,
        );
      }
    }

    const vars = new Map<string, Variable>();
    for (const [name, variable] of this.#vars) {
      vars.set(name, renameVariable(variable, name, dims));
    }

    // Promote each swapped-in variable to a coordinate (new dimension coordinate).
    const coordNames = new Set(this.#coordNames);
    const dataVarNames = new Set(this.#dataVarNames);
    for (const newName of Object.values(dims)) {
      if (vars.has(newName)) {
        coordNames.add(newName);
        dataVarNames.delete(newName);
      }
    }

    // Relabel the (eager) old dimension coordinates onto the new dimension names;
    // they stay coordinates but are no longer dimension coordinates.
    const coords = new Map<string, Coord>();
    for (const [name, coord] of this.#rootCoords) {
      coords.set(name, renameCoord(coord, name, dims));
    }

    const axesByDim = new Map<string, AxisSel>();
    for (const [oldDim, axis] of this.#axesByDim) {
      axesByDim.set(dims[oldDim] ?? oldDim, axis);
    }

    return new Dataset({ vars, coords, coordNames, dataVarNames, attrs: this.attrs }, axesByDim);
  }

  /** Positional selection across the whole Dataset (xarray `Dataset.isel`). */
  isel(selection: IselSelection): Dataset {
    const axes = new Map(this.#axesByDim);
    for (const [dim, indexer] of Object.entries(selection)) {
      if (!axes.has(dim)) {
        throw new Error(`xarray-ts: Dataset has no dimension "${dim}".`);
      }
      axes.set(dim, applyIndexer(axes.get(dim)!, indexer, dim));
    }
    return new Dataset(this.#parts(), axes);
  }

  /** Label-based selection across the whole Dataset (xarray `Dataset.sel`). */
  sel(selection: SelSelection, opts: SelOptions = {}): Dataset {
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

  /**
   * Drop dimensions of size 1 (xarray `Dataset.squeeze`).
   *
   * With no argument, drops every size-1 dimension; with `dim`, drops only those
   * (erroring if a named dimension is not size 1). A dropped dimension coordinate
   * is retained as a scalar coordinate. Metadata-only — no data is read.
   *
   * (xarray's `drop=True` and positional `axis=` forms are not implemented.)
   */
  squeeze(dim?: string | string[]): Dataset {
    const sizes = this.dims; // current sizes, honouring prior isel/sel
    const targets =
      dim === undefined
        ? Object.keys(sizes).filter((d) => sizes[d] === 1)
        : typeof dim === "string"
          ? [dim]
          : dim;
    for (const d of targets) {
      if (!(d in sizes)) {
        throw new Error(`xarray-ts: Dataset has no dimension "${d}".`);
      }
      if (sizes[d] !== 1) {
        throw new Error(
          `xarray-ts: cannot squeeze dimension "${d}" of size ${sizes[d]} (must be 1).`,
        );
      }
    }
    return this.isel(Object.fromEntries(targets.map((d) => [d, 0])));
  }

  /**
   * Node `util.inspect` hook (`console.log`): an xarray-style summary listing
   * dimensions, coordinates and data variables (name, dims, dtype) plus
   * group attributes — no lazy data is read. Ignored by browser consoles.
   */
  [INSPECT](_depth: number, options: InspectOptions, inspect: InspectFn): string {
    const { stylize } = options;
    const label = (text: string) => stylize(text, "undefined");

    const dimStr = `(${Object.entries(this.dims)
      .map(([dim, size]) => `${dim}: ${size}`)
      .join(", ")})`;

    const names = [...this.#coordNames, ...this.#dataVarNames];
    const width = names.reduce((w, n) => Math.max(w, n.length), 0);
    const varLine = (name: string, dims: readonly string[], dtype: string) =>
      `    ${stylize(name.padEnd(width), "string")} ` +
      `${formatDimNames(dims)} ${stylize(dtype, "special")}`;

    const lines = [stylize("Dataset", "special"), `${label("Dimensions:")}  ${dimStr}`];

    const coords = this.coords;
    if (this.#coordNames.size) {
      lines.push(label("Coordinates:"));
      for (const name of this.#coordNames) {
        const coord = coords[name];
        if (coord) lines.push(varLine(name, coord.dims, coord.dtype));
      }
    }
    if (this.#dataVarNames.size) {
      lines.push(label("Data variables:"));
      for (const name of this.#dataVarNames) {
        const v = this.#vars.get(name)!;
        lines.push(varLine(name, v.dims, v.dtype));
      }
    }
    if (Object.keys(this.attrs).length) {
      lines.push(`${label("Attributes:")} ${inspect(this.attrs, options)}`);
    }
    return lines.join("\n");
  }

  /** @internal Build a DataArray for a variable with the Dataset's current selection applied. */
  #dataArray(name: string): DataArray {
    const variable = this.#vars.get(name)!;
    const axes = variable.dims.map((dim) => this.#axisFor(dim));
    return new DataArray(variable, this.#allCoords(), axes);
  }

  /**
   * @internal The full coordinate collection, unsliced: eager {@link Coord}s for
   * dimension coordinates, lazy {@link LazyCoord}s for auxiliary / scalar / N-d
   * coordinates. A DataArray filters these to its own dimensions and slices the
   * eager ones against its positional axes.
   */
  #allCoords(): Map<string, AnyCoord> {
    const out = new Map<string, AnyCoord>();
    for (const name of this.#coordNames) {
      const eager = this.#rootCoords.get(name);
      out.set(name, eager ?? makeLazyCoord(this.#vars.get(name)!));
    }
    return out;
  }

  /** @internal Current axis selection for a dimension (full if untouched/unknown). */
  #axisFor(dim: string): AxisSel {
    return this.#axesByDim.get(dim) ?? fullAxis(this.#dimSizes.get(dim) ?? 0);
  }

  /** @internal Reconstruct the immutable parts bag for deriving a new Dataset. */
  #parts(): DatasetParts {
    return {
      vars: this.#vars,
      coords: this.#rootCoords,
      coordNames: this.#coordNames,
      dataVarNames: this.#dataVarNames,
      attrs: this.attrs,
    };
  }

  #validatedNames(names: Iterable<string>): Set<string> {
    const out = new Set<string>();
    for (const name of names) {
      if (!this.#vars.has(name)) {
        throw new Error(`xarray-ts: no variable named "${name}" in Dataset.`);
      }
      out.add(name);
    }
    return out;
  }

  #subset(keep: Set<string>): Dataset {
    const vars = new Map<string, Variable>();
    const coords = new Map<string, Coord>();
    const coordNames = new Set<string>();
    const dataVarNames = new Set<string>();

    for (const [name, variable] of this.#vars) {
      if (!keep.has(name)) continue;
      vars.set(name, variable);
      if (this.#coordNames.has(name)) {
        coordNames.add(name);
        const coord = this.#rootCoords.get(name);
        if (coord) coords.set(name, coord);
      } else if (this.#dataVarNames.has(name)) {
        dataVarNames.add(name);
      }
    }

    // Only retain axis state for dimensions still spanned by a kept variable;
    // otherwise dims from dropped variables would linger in `dims`/`coords`.
    const keepDims = new Set<string>();
    for (const variable of vars.values()) {
      for (const dim of variable.dims) keepDims.add(dim);
    }
    const axesByDim = new Map([...this.#axesByDim].filter(([dim]) => keepDims.has(dim)));

    return new Dataset(
      {
        vars,
        coords,
        coordNames,
        dataVarNames,
        attrs: this.attrs,
      },
      axesByDim,
    );
  }

  /** @internal Coordinate names that are dimension (index) coordinates. */
  #dimensionCoordNames(): Set<string> {
    const out = new Set<string>();
    for (const name of this.#coordNames) {
      if (isDimensionCoord(this.#vars.get(name)!)) out.add(name);
    }
    return out;
  }

  /**
   * @internal Rebuild the Dataset with new coord/data-var classification (and an
   * optionally reduced `vars`), preserving the current selection. Keeps eager
   * dimension coords only while their variable survives and stays a coordinate;
   * auxiliary coords are reconstructed lazily by the `coords` getter.
   */
  #reclassified(
    coordNames: Set<string>,
    dataVarNames: Set<string>,
    vars: Map<string, Variable> = this.#vars,
  ): Dataset {
    const coords = new Map<string, Coord>();
    for (const [name, coord] of this.#rootCoords) {
      if (vars.has(name) && coordNames.has(name)) coords.set(name, coord);
    }
    const keepDims = new Set<string>();
    for (const variable of vars.values()) {
      for (const dim of variable.dims) keepDims.add(dim);
    }
    const axesByDim = new Map([...this.#axesByDim].filter(([dim]) => keepDims.has(dim)));
    return new Dataset({ vars, coords, coordNames, dataVarNames, attrs: this.attrs }, axesByDim);
  }

  #renamed(varRenames: Record<string, string>, dimRenames: Record<string, string>): Dataset {
    const dimTargets = new Set<string>();
    for (const [oldDim, newDim] of Object.entries(dimRenames)) {
      if (!this.#dimSizes.has(oldDim)) {
        throw new Error(`xarray-ts: Dataset has no dimension "${oldDim}".`);
      }
      if (oldDim !== newDim && this.#dimSizes.has(newDim) && !Object.hasOwn(dimRenames, newDim)) {
        throw new Error(
          `xarray-ts: cannot rename dimension "${oldDim}" to existing dimension "${newDim}".`,
        );
      }
      if (dimTargets.has(newDim)) {
        throw new Error(`xarray-ts: cannot rename multiple dimensions to "${newDim}".`);
      }
      dimTargets.add(newDim);
    }
    const varTargets = new Set<string>();
    for (const [oldName, newName] of Object.entries(varRenames)) {
      if (!this.#vars.has(oldName)) {
        throw new Error(`xarray-ts: no variable named "${oldName}" in Dataset.`);
      }
      if (oldName !== newName && this.#vars.has(newName) && !Object.hasOwn(varRenames, newName)) {
        throw new Error(`xarray-ts: cannot rename "${oldName}" to existing variable "${newName}".`);
      }
      if (varTargets.has(newName)) {
        throw new Error(`xarray-ts: cannot rename multiple variables to "${newName}".`);
      }
      varTargets.add(newName);
    }

    const vars = new Map<string, Variable>();
    const coords = new Map<string, Coord>();
    const coordNames = new Set<string>();
    const dataVarNames = new Set<string>();

    for (const [oldName, variable] of this.#vars) {
      const newName = varRenames[oldName] ?? oldName;
      vars.set(newName, renameVariable(variable, newName, dimRenames));
      if (this.#coordNames.has(oldName)) {
        coordNames.add(newName);
      } else if (this.#dataVarNames.has(oldName)) {
        dataVarNames.add(newName);
      }
    }

    for (const [oldName, coord] of this.#rootCoords) {
      const newName = varRenames[oldName] ?? oldName;
      coords.set(newName, renameCoord(coord, newName, dimRenames));
    }

    const axesByDim = new Map<string, AxisSel>();
    for (const [oldDim, axis] of this.#axesByDim) {
      axesByDim.set(dimRenames[oldDim] ?? oldDim, axis);
    }

    return new Dataset({ vars, coords, coordNames, dataVarNames, attrs: this.attrs }, axesByDim);
  }
}

function renameVariable(
  variable: Variable,
  name: string,
  dimRenames: Record<string, string>,
): Variable {
  return {
    ...variable,
    name,
    dims: variable.dims.map((dim) => dimRenames[dim] ?? dim),
  };
}

function computeDimSizes(vars: Map<string, Variable>): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const v of vars.values()) {
    v.dims.forEach((dim, i) => {
      const size = v.shape[i]!;
      const existing = sizes.get(dim);
      if (existing !== undefined && existing !== size) {
        throw new Error(
          `xarray-ts: inconsistent size for dimension "${dim}" (${existing} vs ${size}).`,
        );
      }
      sizes.set(dim, size);
    });
  }
  return sizes;
}
