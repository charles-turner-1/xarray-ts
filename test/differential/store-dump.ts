/**
 * Dump an in-memory zarrita `Map` fixture store to a temp directory on disk, so
 * that *real* xarray can open the exact same bytes xarray-ts reads. JS stays the
 * single source of truth for the fixture; both engines read identical data.
 *
 * zarrita writes two things zarr-python 3 rejects as spec-loose: `fill_value:
 * null` and an empty `codecs` array. We rewrite those in the copied `zarr.json`
 * metadata only (never the chunk bytes): `fill_value` → `0` (every fixture writes
 * all its data, so the fill is never read), and empty `codecs` → a raw
 * little-endian `bytes` codec, which is exactly how zarrita laid the chunks down.
 *
 * @module
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { MapStore } from "../fixtures.js";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Write every `key → bytes` entry of a Map store as a file under a fresh temp dir. */
export function dumpStore(store: MapStore): string {
  const dir = mkdtempSync(join(tmpdir(), "xarray-ts-diff-"));
  for (const [key, bytes] of store) {
    const rel = key.startsWith("/") ? key.slice(1) : key;
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, rel.endsWith("zarr.json") ? sanitizeMetadata(bytes) : bytes);
  }
  return dir;
}

/** Remove a directory created by {@link dumpStore}. */
export function removeStore(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** Rewrite the zarr-python-incompatible bits of a `zarr.json` (see module docs). */
function sanitizeMetadata(bytes: Uint8Array): Uint8Array {
  const json = JSON.parse(decoder.decode(bytes));
  fixNode(json);
  return encoder.encode(JSON.stringify(json));
}

const BYTES_CODEC = { name: "bytes", configuration: { endian: "little" } };

/** Recursively fix `fill_value`/`codecs` on this node and any nested (consolidated) nodes. */
function fixNode(node: unknown): void {
  if (node === null || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  if (obj.fill_value === null) obj.fill_value = 0;
  if (Array.isArray(obj.codecs) && obj.codecs.length === 0) obj.codecs = [BYTES_CODEC];
  for (const value of Object.values(obj)) {
    if (Array.isArray(value)) value.forEach(fixNode);
    else if (typeof value === "object") fixNode(value);
  }
}
