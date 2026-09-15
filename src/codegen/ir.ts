/**
 * The operation-log IR — a linear list of the transformations a {@link Dataset}
 * (or {@link DataArray}) has had applied, from which we can generate the xarray
 * Python that reproduces the same result.
 *
 * Modelled on [`xrexpr`](https://github.com/charles-turner-1/xrexpr)'s `ir.py`,
 * with two deliberate departures.
 *
 * First, this IR is **fluent-only**: xarray-ts has no optimiser, so there is no
 * lowering pass and no Fluent/Lowered split — one flat list of nodes, and none of
 * the builder half-ops (`ContextOpen`) or fused nodes xrexpr's lowering produces.
 *
 * Second, a node stores the operation's **semantic intent**, not a verbatim
 * `name/args/kwargs` call header. xrexpr records *and* replays the same xarray
 * API, so one verbatim header does double duty; xarray-ts records the xarray-ts
 * (TypeScript) API but *emits* the xarray (Python) API — two different surfaces —
 * so a header of one is not replayable as the other. The node therefore carries
 * intent (a selection mapping, a rename mapping, …) and the emitter maps it to the
 * target xarray call. These fields line up with xrexpr's *normalised metadata*
 * (the half an optimiser reasons about), not its replay header; the door is left
 * open to adding value *classification* (an indexer sum type, a `consumes`
 * derivation) per node later.
 *
 * Node **kinds** track xarray/xrexpr where they exist — `Select` (`isel`/`sel`),
 * `Project`, `Drop`, `Rename` — and are named after the xarray method elsewhere
 * (`set_coords`, `swap_dims`, …). Where a kind spans several xarray methods it
 * carries the method `name` as a discriminator, exactly as xrexpr's `Select` does.
 * `pick` is kept distinct from `project` (see charles-turner-1/xrexpr#198): both
 * are xarray `__getitem__`, but a single-variable projection yields a DataArray and
 * a subset a Dataset, and we keep that split explicit rather than deriving it.
 *
 * Two disciplines carried over from xrexpr. Every `switch (op.kind)` closes with
 * {@link assertNever}, so adding a variant is a compile error at every unhandled
 * site rather than a silent fallthrough. And the node **constructors** live here
 * (not inlined into `Dataset`/`DataArray`), so the "recording" logic is one unit
 * that can be lifted into a standalone recorder object down the line.
 *
 * @module
 */
import type { IselSelection, SelOptions, SelSelection } from "../types.js";

/** Open a store as a Dataset — the head of every chain (`xr.open_dataset(...)`). */
export interface OpenOp {
  readonly kind: "open";
  /** A Python expression for the store argument, best-effort (a URL string, or `store`). */
  readonly source: string;
  /** Options forwarded to `open_dataset` (e.g. `group=`), verbatim. */
  readonly kwargs: Readonly<Record<string, unknown>>;
}

/** A positional (`isel`) or label (`sel`) selection. */
export interface SelectOp {
  readonly kind: "select";
  readonly name: "isel" | "sel";
  /** The `{dim: indexer}` / `{dim: label}` mapping, verbatim. */
  readonly selection: IselSelection | SelSelection;
  /** `sel` options (e.g. `method="nearest"`); absent for `isel`. */
  readonly opts?: SelOptions;
}

/**
 * A rename, discriminated by the literal xarray method it emits (see CLAUDE.md).
 *
 * `name` spans the xarray rename family — `rename` (the general Dataset rename and
 * DataArray dim/coord rename), `rename_vars`, `rename_dims` — mirroring how
 * {@link SelectOp} carries `isel`/`sel`. The `arg` is the literal call argument:
 * a `{old: new}` mapping for every form, or a bare string for the DataArray
 * `rename("newName")` that renames the array itself (only valid with `name:
 * "rename"`). The emitter renders `arg` as-is, so the scalar/mapping distinction
 * is the stored argument, not a derived flag.
 */
export interface RenameOp {
  readonly kind: "rename";
  readonly name: "rename" | "rename_vars" | "rename_dims";
  readonly arg: string | Readonly<Record<string, string>>;
}

/** A `drop_vars` call. */
export interface DropOp {
  readonly kind: "drop";
  readonly variables: readonly string[];
}

/** A variable subset — xarray `ds[["a", "b"]]` (xarray-ts `pickVars`). */
export interface PickOp {
  readonly kind: "pick";
  readonly variables: readonly string[];
}

/** A `set_coords` call — promote data variables to coordinates. */
export interface SetCoordsOp {
  readonly kind: "set_coords";
  readonly variables: readonly string[];
}

/** A `reset_coords` call — demote coordinates back to data variables (or drop them). */
export interface ResetCoordsOp {
  readonly kind: "reset_coords";
  /** Absent means "every non-dimension coordinate" (bare `reset_coords()`). */
  readonly variables?: readonly string[];
  readonly drop?: boolean;
}

/** A `swap_dims` call — exchange dimension(s) for 1-D variables along them. */
export interface SwapDimsOp {
  readonly kind: "swap_dims";
  readonly mapping: Readonly<Record<string, string>>;
}

/** A `squeeze` call — drop size-1 dimensions (all of them when `dim` is absent). */
export interface SqueezeOp {
  readonly kind: "squeeze";
  readonly dim?: string | readonly string[];
}

/** Project a single variable to a DataArray — xarray `ds["name"]` (xarray-ts `get`). */
export interface ProjectOp {
  readonly kind: "project";
  readonly name: string;
}

/**
 * One operation in the log. A discriminated union over the operation *kinds* the
 * emitter distinguishes; `match`/`switch` on `.kind` and close with
 * {@link assertNever} so the set stays exhaustive.
 */
export type Op =
  | OpenOp
  | SelectOp
  | RenameOp
  | DropOp
  | PickOp
  | SetCoordsOp
  | ResetCoordsOp
  | SwapDimsOp
  | SqueezeOp
  | ProjectOp;

// --- constructors (the "recorder": the one place nodes are minted) -----------

/** Record a store open. */
export const open = (source: string, kwargs: Record<string, unknown> = {}): OpenOp => ({
  kind: "open",
  source,
  kwargs,
});

/** Record an `isel`/`sel` selection. */
export const select = (
  name: "isel" | "sel",
  selection: IselSelection | SelSelection,
  opts?: SelOptions,
): SelectOp => ({ kind: "select", name, selection, ...(opts ? { opts } : {}) });

/** Record a rename, named by the xarray method it emits (`rename`/`rename_vars`/`rename_dims`). */
export const rename = (
  name: "rename" | "rename_vars" | "rename_dims",
  arg: string | Record<string, string>,
): RenameOp => ({ kind: "rename", name, arg });

/** Record a `drop_vars`. */
export const drop = (variables: Iterable<string>): DropOp => ({
  kind: "drop",
  variables: [...variables],
});

/** Record a variable subset (`ds[[...]]`). */
export const pick = (variables: Iterable<string>): PickOp => ({
  kind: "pick",
  variables: [...variables],
});

/** Record a `set_coords`. */
export const setCoords = (variables: Iterable<string>): SetCoordsOp => ({
  kind: "set_coords",
  variables: [...variables],
});

/** Record a `reset_coords`. */
export const resetCoords = (
  variables: Iterable<string> | undefined,
  drop?: boolean,
): ResetCoordsOp => ({
  kind: "reset_coords",
  ...(variables ? { variables: [...variables] } : {}),
  ...(drop ? { drop } : {}),
});

/** Record a `swap_dims`. */
export const swapDims = (mapping: Record<string, string>): SwapDimsOp => ({
  kind: "swap_dims",
  mapping,
});

/** Record a `squeeze` (bare, or over the given dim(s)). */
export const squeeze = (dim?: string | readonly string[]): SqueezeOp => ({
  kind: "squeeze",
  ...(dim === undefined ? {} : { dim }),
});

/** Record a single-variable projection (`ds["name"]`). */
export const project = (name: string): ProjectOp => ({ kind: "project", name });

/** Append one op to an immutable log, returning a new log. */
export const append = (ops: readonly Op[], op: Op): readonly Op[] => [...ops, op];

/**
 * Exhaustiveness guard: reached only if a new {@link Op} variant is added without
 * a matching `switch` arm, in which case it is a compile error at the call site.
 */
export function assertNever(x: never): never {
  throw new Error(`xarray-ts: unhandled IR op ${JSON.stringify(x)}`);
}
