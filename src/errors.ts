/**
 * Error types thrown by xarray-ts.
 *
 * @module
 */

/** Thrown by API surface that is intentionally stubbed (e.g. nested groups). */
export class NotImplementedError extends Error {
  override readonly name = "NotImplementedError";
  constructor(message: string) {
    super(message);
  }
}

/** Thrown when a group's variables cannot be enumerated (no consolidated metadata, no explicit list). */
export class EnumerationError extends Error {
  override readonly name = "EnumerationError";
  constructor(message: string) {
    super(message);
  }
}
