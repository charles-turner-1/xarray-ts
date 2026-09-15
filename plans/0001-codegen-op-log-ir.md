# xarray-ts codegen: an operation-log IR that emits xarray Python

## Context

Issue #4 asks for a "write-log / codegen" capability: as a user explores and transforms a
`Dataset` interactively in the browser, xarray-ts should be able to hand back copy-pasteable
**Python xarray** code reproducing the same result.

The user wants this built on an IR modelled on [`xrexpr`](https://github.com/charles-turner-1/xrexpr)'s
`ir.py` — a linear list of per-operation nodes, each carrying the **verbatim call header**
(`name`, `args`, `kwargs`). xrexpr's own pipeline is the template:

```
record (fluent calls) → FluentOp[] → lower/optimise → LoweredOp[] → emit → Call[] → render text
```

xarray-ts is read-only and immutable (every transform returns a new `Dataset`), so an op-log
threads naturally through the object. Decisions confirmed with the user:

- **Target: Python xarray only.** (`openDataset → xr.open_dataset`, `isel → .isel`, …)
- **IR fidelity: codegen-only node kinds now**, but _structured to not close the door_ to
  adding xrexpr-style normalised metadata + an optimiser later (so an interactively-built
  chain could one day emit an _optimised_ xarray call).
- **Always-on immutable op-log** carried on every `Dataset`/`DataArray`, but the
  node-construction ("recording") logic is centralised so it can be extracted into a
  standalone recorder object later.

## Design

Mirror xrexpr's three-stage seam so the optimiser door stays open, even though the middle
stage is currently a no-op:

```
Op[]  ──(lower/optimise: identity for now)──►  Op[]  ──emit──►  Call[]  ──render──►  Python string
```

### New module: `src/codegen/ir.ts`

A discriminated union `Op` over operation _kinds_, one node per fluent call, each holding the
verbatim header plus a `target` discriminant (`"ds"` vs `"da"`). Mirror xrexpr's kind names
where they exist; add the head node xrexpr lacks. Keep every node a plain readonly object.

- `DatasetOpen` — the head (xrexpr has no such node; this is the new one the user called out).
  Holds `{ kind: "open", source, kwargs }` where `source` is a best-effort Python literal for
  the store (see open.ts below).
- `Select` — `isel`/`sel`. `{ kind: "select", name: "isel" | "sel", selection, opts }`.
- `Rename` — `{ kind: "rename", scope: "vars" | "dims", mapping }` (renameVars / renameDims).
- `Drop` — `{ kind: "drop", variables }` (dropVars).
- `Pick` — `{ kind: "pick", variables }` (pickVars → `ds[[...]]`).
- `SetCoords` / `ResetCoords` — `{ variables, drop? }`.
- `Project` — DataArray access `ds.get(name)` → `ds["name"]`. `{ kind: "project", name }`.
- `RenameVar` — DataArray `.rename(name)`.

Discipline copied from xrexpr: every `switch (op.kind)` closes with an `assertNever(op)`
default (add a tiny `assertNever` helper), so adding a kind is a compile error at every
unhandled site. Leave each node's shape open to _optional_ normalised-metadata fields later
(e.g. a future `consumes`/classified indexer) without touching the emitter — document this
intent in the module docstring, as xrexpr's ir.py does.

Node **constructors** (small pure functions, e.g. `select("isel", selection)`) live here too —
this is the "recorder" logic kept out of `Dataset` internals so it can be extracted to a
standalone object later. `Dataset` methods only call a constructor and append.

### New module: `src/codegen/emit.ts`

- `type Call = { receiver: "ds" | "da"; method: string | "__getitem__"; args; kwargs }` —
  the xrexpr `Call` analogue: pure codegen output, no metadata.
- `emit(ops): Call[]` — maps each `Op` to one (or more) xarray `Call`s. Name mapping:
  `open→open_dataset`, `isel/sel→isel/sel`, rename→`rename_vars`/`rename_dims`,
  `drop→drop_vars`, `pick→__getitem__` (list key), `setCoords→set_coords`,
  `resetCoords→reset_coords` (+ `drop=True`), `project→__getitem__` (str key),
  `renameVar→rename`. This is the seam a future `lower`/`optimise` pass would sit in front of.
- `renderArg(value): string` — JS value → Python literal: `number`→as-is, `string`→quoted,
  `boolean`→`True`/`False`, `null`/`undefined`→`None`, array→`[...]`, plain object→`{...}`
  (dict), and **`SliceArg`/label-slice → `slice(a, b, c)`** (see `src/indexing.ts`, `types.ts`).
- `renderPython(calls, { varName = "ds", withImport = true }): string` — joins into:
  ```python
  import xarray as xr
  ds = xr.open_dataset("s3://…/repo")
  ds = ds.isel(time=0).rename_vars({"tas": "temperature"})
  ```
  `__getitem__` renders as `ds["name"]` / `ds[["a", "b"]]`; the open head is the RHS seed,
  the rest chain with `.`. A projection (`project`) switches the working variable name to `da`.

### Thread the op-log through the immutable objects

`src/dataset.ts`:

- Add `readonly #ops: readonly Op[]` and a third constructor param `ops: readonly Op[] = []`.
- Every derivation helper (`#subset`, `#reclassified`, `#renamed`, and the direct
  `new Dataset(...)` in `isel`) must forward `[...this.#ops, node]`. Give `#subset`/
  `#reclassified`/`#renamed` an explicit `op: Op` parameter so each public caller records the
  right node (dropVars vs pickVars both go through `#subset`).
- **Record at the public API boundary, verbatim** (xrexpr's rule): `sel` currently delegates to
  `isel`. Split out a private `#iselAxes(selection)` doing the axis work _without_ recording;
  public `isel` and `sel` each append their own node (`Select{name:"isel"}` /
  `Select{name:"sel"}`) so emitted code shows `.sel(...)`, not the lowered `.isel(...)`.
- Add `toPython(opts?): string` and a `get ops(): readonly Op[]` (for inspection/tests).

`src/dataarray.ts`:

- Same `#ops` field + constructor param; `isel`/`sel`/`rename` append nodes (target `"da"`),
  add `toPython()` and `ops` getter.
- `Dataset.get(name)` (in `#dataArray`, but only via the public `get`) threads
  `[...this.#ops, project(name)]` into the returned DataArray. The bulk getters
  (`data_vars`/`variables`/`coords`) produce un-logged inspection views (empty ops) — codegen
  chains flow through `.get()`.

`src/open.ts` + `src/group.ts`:

- `datasetFromGroup(group, arrayNames, ops?: readonly Op[])` — new optional seed param, passed
  straight to `new Dataset(parts, undefined, ops)`.
- `openDataset` builds the `DatasetOpen` head and seeds it. **Source literal is best-effort**:
  read `store.url` if present (zarrita `FetchStore` exposes it) → emit that string; otherwise
  emit a bare `store` identifier and prepend a `# store = ...` comment. `openZarr` records the
  same (`open_dataset`); note `path`/`consolidated` options can ride along as kwargs.

`src/index.ts`: export `Op`, `toPython` option types, and the `emit`/`renderPython` functions
(useful for view layers and unit tests).

One extra `toPython` option, needed by the differential oracle below: `{ head: boolean }`
(default `true`). With `head: false` it emits only the transform tail — `ds.isel(time=0)
.drop_vars(["y"])` — so the oracle can `eval` it against a pre-opened `ds` without re-opening.

## Testing

### Tier 1 — pure unit tests (always run, in `npm test`)

`test/codegen.test.ts`: `renderPython(emit(ops))` on hand-built `Op[]` — assert exact strings for
`isel`/`sel` (incl. slices → `slice(...)`), `rename_vars`/`rename_dims`, `drop_vars`,
`ds[["a","b"]]`, `set_coords`/`reset_coords(drop=True)`, and a `ds["tas"].isel(...)` projection.
Plus a small integration test: open a `test/fixtures.ts` store, run a real chain, assert
`.toPython()` matches the expected full script (with the `xr.open_dataset(...)` head).

Existing suites (`api`, `integration`, `indexing`) must stay green — proves the op-log threading
didn't change transform behaviour.

### Tier 2 — differential property tests vs real xarray (opt-in, pixi + fast-check)

A separate, opt-in job — **not** part of `npm test`. It generates random valid op-chains, applies
them to xarray-ts, feeds the _generated Python_ to real xarray, and asserts the two agree on
**structure + a value spot-check**. Dataset ops **and** projection-to-DataArray chains are
generated.

Tooling:

- `pixi.toml` — a Python env with `xarray`, `zarr` (v3), `numpy` (+ `nodejs`), and a task
  `test-differential = "vitest run -c vitest.differential.config.ts"`. Run via `pixi run
test-differential`, so the spawned oracle finds an xarray-equipped `python`.
- Add `fast-check` as a devDependency.
- `vitest.differential.config.ts` includes only `test/differential/**`; the default
  `vitest.config.ts` **excludes** it, so `npm test` never needs Python.

Design (bridge JS ↔ Python; JS is the source of truth):

- `test/differential/store-dump.ts` — dump a zarrita `Map` fixture to a temp dir: for each
  `[key, bytes]`, write `tmp + key` (mkdir-p per file). Both engines then read identical bytes.
- `test/differential/oracle.py` — a **persistent** process: `ds = xr.open_dataset(tmpdir,
engine="zarr")` **once**, then loop over line-delimited JSON on stdin. Each message carries the
  emitted transform tail (`toPython({ head: false })`); the oracle `eval`s `result = <tail>` in a
  namespace holding `xr` and `ds`, then replies with JSON `{ dims, data_vars, coords, sig }` where
  `sig` is per-**data-variable** `{ shape, sum, first, last }` from `result.load()`. Evaluating the
  rendered string is the point — it tests the actual codegen output, not a re-interpretation.
- `test/differential/oracle.ts` — spawn/manage the subprocess, one request→response per chain,
  killed in `afterAll`.
- `test/differential/model.ts` — a fast-check **model-guided chain arbitrary**: fold a schema model
  (dims→size, data_vars, coords, dim-coords, known non-time coord labels) through `fc` so every
  generated op is valid against the running schema. Ops: `isel` (any dim; int drops it), `sel`
  (**non-time** numeric dim-coords only — time is CF-decoded to epoch-ms in xarray-ts vs datetime64
  in xarray, so labels wouldn't match), `drop_vars`/`pick_vars`/`rename_vars`/`rename_dims`
  (fresh targets tracked in the model), `set_coords`/`reset_coords`, and a terminal `project`
  (`ds.get(name)`) optionally followed by DataArray `isel`/`sel`/`rename`.
- `test/differential/differential.test.ts` — `beforeAll`: dump store + spawn oracle. Property: for
  each generated chain, apply to the xarray-ts `Dataset` (sync), collect its
  `{dims, data_vars, coords, sig}` (sig via `.values()` on data vars, same `{shape,sum,first,last}`),
  send the chain's `toPython({head:false})` to the oracle, and assert deep-equal (float sums with a
  tolerance). Value spot-check covers **data variables** only (coords, esp. time, excluded from the
  value compare for the decode-representation reason above). Projection chains compare the resulting
  DataArray's dims/shape + its single-variable signature.

## Files

- NEW `src/codegen/ir.ts` — `Op` union, `assertNever`, node constructors.
- NEW `src/codegen/emit.ts` — `Call`, `emit`, `renderArg`, `renderPython`.
- MODIFY `src/dataset.ts` — `#ops`, ctor param, thread helpers, split `#iselAxes`, `toPython`, `ops`.
- MODIFY `src/dataarray.ts` — `#ops`, ctor param, record isel/sel/rename, `toPython`, `ops`.
- MODIFY `src/open.ts` — build/seed `DatasetOpen`, derive source literal.
- MODIFY `src/group.ts` — `datasetFromGroup` optional `ops` seed.
- MODIFY `src/index.ts` — exports.
- NEW `test/codegen.test.ts` — Tier 1 unit + integration.
- NEW `pixi.toml`, `vitest.differential.config.ts`; MODIFY `vitest.config.ts` (exclude
  `test/differential/**`), `package.json` (add `fast-check` devDep).
- NEW `test/differential/{store-dump.ts, oracle.py, oracle.ts, model.ts, differential.test.ts}`.

## Verification

- `npm run typecheck` — confirms `assertNever` exhaustiveness and the threading compile.
- `npm test` — Tier 1 + existing suites, no Python needed.
- `pixi run test-differential` — Tier 2 differential property tests against real xarray.
