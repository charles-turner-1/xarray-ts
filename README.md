# xarray-ts

> [!WARNING]
> This is a **work in progress**, and I've had Claude (Opus 4.8) scaffold it for me. Because of that, it might look good (IDK),
> but it is certainly not complete or and has not been drive-tested in any meaningful sense of the word. Claims about functionality
> in this README should be considered probable at best, and aspirational at worst.
> Use at your own caution (whilst this warning is still up. I'll get rid of it once I'm confident in the codebase).

A minimal, read-only **xarray metadata layer** for zarr v3 / icechunk in the browser.

`xarray-ts` reinterprets the zarr arrays produced by serialising an xarray
`Dataset` (e.g. to an [icechunk](https://icechunk.io) store) into an
xarray-shaped object — dimensions, coordinates, data variables, attributes —
that view layers can introspect, while streaming actual slices on demand through
[zarrita](https://zarrita.dev).

It is **not** a reimplementation of xarray. It does exactly one job: turn a zarr
group into the metadata you need to drive a viewer, and make selecting a slice a
one-liner.

```
icechunk-js / zarrita FetchStore   →   xarray-ts   →   your view layer
   (bytes, chunks, AsyncReadable)      (this lib)       (rendering)
```

## Install

```sh
npm install xarray-ts zarrita
# optional, for icechunk repos:
npm install icechunk-js
```

## Quickstart

```ts
import { openDataset, fromIcechunk } from "xarray-ts";

const store = await fromIcechunk("https://bucket.s3.amazonaws.com/repo");
const ds = await openDataset(store);

ds.dims; // { time: 365, y: 720, x: 1440 }
ds.attrs; // group-level attributes
ds.coords.time.dates(); // Date[] — CF time axis decoded for you
ds.coords.x.values; // number[] — eagerly loaded

// Stream just the slice you need; coordinates are metadata, data is lazy.
const frame = await ds.get("temperature").isel({ time: 0 }).load();
frame.data; // a (y, x) TypedArray, fetched via zarrita
frame.shape; // [720, 1440]
```

Plain zarr v3 over HTTP works too:

```ts
import { openDataset, fromHttp } from "xarray-ts";
const ds = await openDataset(fromHttp("https://example.com/data.zarr"));
```

Any zarrita `Readable` store is accepted, so `openDataset(store)` works with
`FetchStore`, `icechunk-js`, an in-memory `Map`, or your own store.

## What it interprets

- **Dimensions** from the zarr v3 `dimension_names` metadata field (synthetic
  `*_dim_*` names with a warning if absent).
- **Coordinates vs data variables** using xarray's rule: a variable is a
  coordinate if it is named after a dimension, or referenced by some data
  variable's `coordinates` attribute. Everything else is a data variable.
- **Eagerly-loaded coordinates** — coordinate arrays are small, so their values
  are read and cached up front; data variables stay lazy.
- **CF time decoding** — coordinates with `units = "<unit> since <reference>"`
  are decoded to epoch milliseconds (and `Date[]` via `coord.dates()`). Only
  standard / proleptic-Gregorian calendars are decoded; non-standard calendars
  (`noleap`, `360_day`, …) are left raw and flagged (`coord.decoded === false`).

It deliberately does **not** apply `scale_factor` / `add_offset` / `_FillValue`
masking, and does not implement computation, alignment, or writing.

## Selection

`DataArray` and `Dataset` both support positional (`isel`) and label-based
(`sel`) selection. Both return new lazy views — nothing is fetched until
`.load()` / `.values()`.

```ts
const da = ds.get("temperature");

da.isel({ time: 0 }); // integer index drops the dim
da.isel({ x: { start: 100, stop: 200 } }); // half-open slice keeps the dim
da.sel({ time: new Date("2020-06-01") }); // label lookup via the coordinate
da.sel({ time: someDate }, { method: "nearest" });
da.sel({ y: { start: -40, stop: 40 } }); // inclusive label range

await da.isel({ time: 0 }).load(); // -> { data, shape, stride } (zarrita Chunk)
await da.isel({ time: 0 }).values(); // -> just the TypedArray (or a scalar)

ds.isel({ time: 0 }); // selects across every variable -> new Dataset
```

## Enumerating variables

To list a group's variables without per-array round-trips, `openDataset` uses
**consolidated metadata** when present (a single fetch). xarray and icechunk
write this by default. If a store has no consolidated metadata and cannot list
its own children, pass the names explicitly:

```ts
await openDataset(store, { variables: ["time", "x", "y", "temperature"] });
```

## Nested groups / DataTree

This package opens a **single group** at a path (`openDataset(store, { path })`)
and returns a flat `Dataset`. Recursive, nested-group / DataTree traversal is
intentionally **out of scope here** and owned by a separate library, which plugs
into this one through a clearly defined seam:

- **`datasetFromGroup(group, arrayNames)`** — the reusable core that turns one
  already-resolved zarrita `Group` (plus the names of its child arrays) into a
  `Dataset`. A hierarchy walker calls this **per node**, so the metadata
  interpretation lives in exactly one place.
- **`childArrayNames(contents, groupPath)`** — given a consolidated-metadata
  listing, the direct-child array names of a group.
- **`GroupNode`** — the documented tree-node contract (`{ path, dataset,
children }`) the external library produces/consumes.
- **`openDatatree()`** — a stub that throws `NotImplementedError` pointing here.

```ts
import { datasetFromGroup, type GroupNode } from "xarray-ts";
```

## API

| Export                                             | Description                                                                                            |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `openDataset(store, opts?)`                        | Open a zarr v3 store as a `Dataset`.                                                                   |
| `openZarr`                                         | Alias of `openDataset`.                                                                                |
| `fromIcechunk(url, opts?)`                         | Open an icechunk repo as a store (needs `icechunk-js`).                                                |
| `fromHttp(url, opts?)`                             | Open a plain zarr v3 store over HTTP (`FetchStore`).                                                   |
| `Dataset`                                          | `dims`, `coords`, `data_vars`, `variables`, `attrs`, `get`, `renameVars`, `renameDims`, `isel`, `sel`. |
| `DataArray`                                        | `dims`, `shape`, `coords`, `attrs`, `dtype`, `rename`, `isel`, `sel`, `load`, `values`.                |
| `Coord`                                            | `values`, `dims`, `attrs`, `isTime`, `decoded`, `dates()`.                                             |
| `datasetFromGroup`, `childArrayNames`, `GroupNode` | The nested-group seam.                                                                                 |
| `openDatatree`                                     | Stub (throws `NotImplementedError`).                                                                   |

## Development

```sh
npm test            # run the hermetic in-memory unit tests
npm run test:watch  # watch mode
npm run typecheck   # tsc --noEmit (strict)
npm run build       # emit ESM + .d.ts to dist/
npm run check:package # assert the public package surface stays self-contained

# opt-in integration test against a real icechunk repo:
ICECHUNK_TEST_URL=https://… npm test
```

## License

Apache 2.0, see [LICENSE](LICENSE).
