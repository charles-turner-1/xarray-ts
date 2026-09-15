# xarray-ts — working notes for Claude

`xarray-ts` is a minimal, read-only **xarray metadata layer** for zarr v3 / icechunk in the
browser. It reinterprets the zarr arrays produced by serialising an xarray `Dataset` into an
xarray-shaped object (dims, coordinates, data variables, attributes) and streams slices on
demand via zarrita. It is **not** a reimplementation of xarray.

## The fidelity principle (read this before adding or changing behaviour)

**xarray-ts mirrors xarray. Reproduce xarray's behaviour as closely as possible — never
"improve", "optimise", or second-guess it.**

Concretely:

1. **Public methods track their xarray analogue 1:1.** A method named after an xarray method
   (`isel`, `sel`, `rename_vars`/`renameVars`, `drop_vars`/`dropVars`, `set_coords`,
   `swap_dims`, `squeeze`, …) must produce the _same result_ xarray produces for the same
   input, down to which dims/coords/variables survive and how they are classified. If you
   find a method that diverges from xarray, that is a **bug in xarray-ts** to fix — not a
   quirk to preserve or to work around elsewhere.

2. **Codegen emits the literal 1:1 xarray call.** The codegen layer (`src/codegen/`) turns an
   xarray-ts operation log into xarray Python. Each op emits the _direct_ xarray call for the
   method the user invoked — `renameDims` → `rename_dims`, `renameVars` → `rename_vars`,
   `pickVars` → `ds[[...]]`, and so on. **Do not substitute a different xarray call because you
   believe it reproduces the result more faithfully.** If a literal mapping would _not_
   reproduce the xarray-ts result, do not paper over it in the emitter: that mismatch means
   xarray-ts itself diverges from xarray (point 1), and the fix belongs in the method, on a
   branch off `main`, first.

3. **Verify fidelity empirically, not from memory.** Do not assert what an xarray method does
   from recollection. Confirm it — ideally with the differential tests (`pixi run
test-differential`), which run the generated Python against real xarray and compare the
   resulting dataset. When those tests surface a divergence, that is the signal to pause and
   fix xarray-ts off `main`.

4. **The one allowed class of exception: TypeScript is not duck-typed.** Where xarray/Python
   relies on duck typing and TypeScript cannot, we must name concrete types instead (e.g.
   `instanceof CFDatetime` and importing the class rather than structural matching for CF
   time labels in `src/indexing.ts`). Structural TS-vs-Python differences like this are
   acceptable and should be commented as deliberate. They are the _only_ reason to depart
   from a literal mirror — and even then, the observable result should still match xarray.

If you are ever tempted to make xarray-ts cleaner, simpler, or smarter than xarray: stop, and
mirror xarray instead.

## Workflow

- **Stacked PRs for large changes.** Chain branches (`feature/1-x` → `feature/2-y` → …), each
  a reviewable layer; rebase the stack when `main` moves.
- **Before finishing:** `npm run typecheck`, `npm test`, `npm run lint` must all pass. Run
  `npm run format` to fix formatting.
- **Commits** end with the co-author trailer; **PR descriptions** end with the Claude Code
  attribution line.
