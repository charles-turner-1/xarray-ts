"""Persistent differential-test oracle: run generated xarray code against *real* xarray.

Opens the dumped store **once** as ``ds``, then reads line-delimited JSON requests
from stdin — each ``{"id", "code"}`` where ``code`` is the transform tail xarray-ts
emitted (e.g. ``ds.isel(time=0)["temperature"]``). It ``eval``s that against the
open dataset and replies, one JSON line per request, with the resulting structure
and a per-data-variable value signature. Evaluating the emitted string is the
point: it exercises the actual codegen output, not a re-interpretation of it.

Coordinates are deliberately excluded from the value signature — xarray-ts decodes
CF time to epoch-ms while xarray uses ``datetime64``, so coord *values* wouldn't
compare across the boundary (dims/names still do).

Usage: ``python oracle.py <store-dir>``.
"""

import json
import sys

import numpy as np
import xarray as xr


def sig_of(da: xr.DataArray) -> dict:
    """A cheap, comparable value signature for one array: shape + sum/first/last."""
    arr = np.asarray(da.values, dtype="float64").ravel()
    if arr.size == 0:
        return {"shape": list(da.shape), "sum": None, "first": None, "last": None}
    return {
        "shape": list(da.shape),
        "sum": float(np.nan_to_num(arr).sum()),
        "first": float(arr[0]),
        "last": float(arr[-1]),
    }


def describe(result) -> dict:
    """Structure + value signature of an eval result (a Dataset or a DataArray)."""
    if isinstance(result, xr.Dataset):
        return {
            "kind": "dataset",
            "dims": {str(k): int(v) for k, v in result.sizes.items()},
            "data_vars": sorted(map(str, result.data_vars)),
            "coords": sorted(map(str, result.coords)),
            "sig": {str(k): sig_of(result[k]) for k in result.data_vars},
        }
    if isinstance(result, xr.DataArray):
        return {
            "kind": "dataarray",
            "name": None if result.name is None else str(result.name),
            "dims": {str(k): int(v) for k, v in result.sizes.items()},
            "coords": sorted(map(str, result.coords)),
            "sig": sig_of(result),
        }
    raise TypeError(f"unexpected result type {type(result).__name__}")


def main() -> None:
    store = sys.argv[1]
    ds = xr.open_dataset(store, engine="zarr")
    env = {"xr": xr, "np": np, "ds": ds}

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        msg = json.loads(line)
        try:
            result = eval(msg["code"], env)  # noqa: S307 — trusted, our own codegen
            out = {"id": msg["id"], "ok": True, **describe(result)}
        except Exception as exc:  # report, don't die — one bad chain shouldn't kill the run
            out = {"id": msg["id"], "ok": False, "error": f"{type(exc).__name__}: {exc}"}
        sys.stdout.write(json.dumps(out) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
