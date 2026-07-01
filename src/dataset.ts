/**
 * {@link Dataset}: a collection of {@link DataArray}s sharing dimensions and
 * coordinates — the xarray-shaped object produced by {@link openDataset}.
 *
 * @module
 */
import { applyIndexer, fullAxis, sliceCoord, type AxisSel } from "./axis.js";
import { DataArray } from "./dataarray.js";
import { isLabelSlice, lookupLabel, lookupLabelSlice, toSliceArg } from "./indexing.js";
import { INSPECT, formatDimNames, type InspectFn, type InspectOptions } from "./repr.js";
import type { Attrs, Coord, IselSelection, SelOptions, SelSelection, Variable } from "./types.js";

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

  /** Coordinates, sliced to the current selection (presentational). */
  get coords(): Record<string, Coord> {
    const out: Record<string, Coord> = {};
    for (const [name, coord] of this.#rootCoords) {
      out[name] =
        coord.dims.length === 1 ? sliceCoord(coord, this.#axisFor(coord.dims[0]!)) : coord;
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

  /** Rename variables/coordinates without touching underlying data values. */
  renameVars(names: Record<string, string>): Dataset {
    return this.#renamed(names, {});
  }

  /**
   * Rename dimensions; if a dimension coordinate shares the old dimension name,
   * rename that coordinate variable too so `.sel()` and `ds.coords` stay aligned.
   */
  renameDims(names: Record<string, string>): Dataset {
    const withDimCoords = { ...names };
    for (const [oldDim, newDim] of Object.entries(names)) {
      if (this.#coordNames.has(oldDim)) withDimCoords[oldDim] = newDim;
    }
    return this.#renamed(withDimCoords, names);
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
      positional[dim] = isLabelSlice(label)
        ? toSliceArg(lookupLabelSlice(coord, label))
        : lookupLabel(coord, label, opts);
    }
    return this.isel(positional);
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
    return new DataArray(variable, this.#rootCoords, axes);
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

  #renamed(varRenames: Record<string, string>, dimRenames: Record<string, string>): Dataset {
    for (const [oldDim, newDim] of Object.entries(dimRenames)) {
      if (!this.#dimSizes.has(oldDim)) {
        throw new Error(`xarray-ts: Dataset has no dimension "${oldDim}".`);
      }
      if (oldDim !== newDim && this.#dimSizes.has(newDim) && !Object.hasOwn(dimRenames, newDim)) {
        throw new Error(`xarray-ts: cannot rename dimension "${oldDim}" to existing dimension "${newDim}".`);
      }
    }
    for (const [oldName, newName] of Object.entries(varRenames)) {
      if (!this.#vars.has(oldName)) {
        throw new Error(`xarray-ts: no variable named "${oldName}" in Dataset.`);
      }
      if (oldName !== newName && this.#vars.has(newName) && !Object.hasOwn(varRenames, newName)) {
        throw new Error(`xarray-ts: cannot rename "${oldName}" to existing variable "${newName}".`);
      }
    }

    const vars = new Map<string, Variable>();
    const coords = new Map<string, Coord>();
    const coordNames = new Set<string>();
    const dataVarNames = new Set<string>();

    for (const [oldName, variable] of this.#vars) {
      const newName = varRenames[oldName] ?? oldName;
      const renamed = renameVariable(variable, newName, varRenames, dimRenames);
      vars.set(newName, renamed);
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
  varRenames: Record<string, string>,
  dimRenames: Record<string, string>,
): Variable {
  return {
    ...variable,
    name,
    dims: variable.dims.map((dim) => dimRenames[dim] ?? dim),
    attrs: renameCoordReferences(variable.attrs, varRenames),
  };
}

function renameCoord(coord: Coord, name: string, dimRenames: Record<string, string>): Coord {
  const values = coord.values;
  return {
    ...coord,
    name,
    dims: coord.dims.map((dim) => dimRenames[dim] ?? dim),
    dates(): Date[] | undefined {
      if (!coord.isTime || !coord.decoded) return undefined;
      return (values as number[]).map((ms) => new Date(ms));
    },
  };
}

function renameCoordReferences(attrs: Attrs, varRenames: Record<string, string>): Attrs {
  const coordsAttr = attrs["coordinates"];
  if (typeof coordsAttr !== "string") return attrs;
  const renamed = coordsAttr
    .split(/\s+/)
    .filter(Boolean)
    .map((name) => varRenames[name] ?? name)
    .join(" ");
  return { ...attrs, coordinates: renamed };
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
