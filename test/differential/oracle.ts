/**
 * Drive the persistent Python {@link file://./oracle.py} oracle over a
 * line-delimited JSON protocol: one request (a transform tail to `eval`) in, one
 * structure-and-signature response out. Kept alive across a whole property run so
 * xarray import + store open are paid once.
 *
 * @module
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

/** One array's value signature (data variables only; see oracle.py). */
export interface Sig {
  shape: number[];
  sum: number | null;
  first: number | null;
  last: number | null;
}

/** The oracle's description of an eval result. */
export interface OracleResult {
  id: number;
  ok: boolean;
  error?: string;
  kind?: "dataset" | "dataarray";
  name?: string | null;
  dims?: Record<string, number>;
  data_vars?: string[];
  coords?: string[];
  sig?: Sig | Record<string, Sig>;
}

/** A live oracle subprocess. */
export class Oracle {
  readonly #proc: ChildProcessWithoutNullStreams;
  readonly #rl: Interface;
  readonly #pending = new Map<number, (r: OracleResult) => void>();
  #nextId = 0;
  #stderr = "";

  constructor(scriptPath: string, storeDir: string, python = "python") {
    this.#proc = spawn(python, [scriptPath, storeDir]);
    this.#proc.stderr.on("data", (d: Buffer) => {
      this.#stderr += d.toString();
    });
    this.#rl = createInterface({ input: this.#proc.stdout });
    this.#rl.on("line", (line) => {
      if (!line.trim()) return;
      const msg = JSON.parse(line) as OracleResult;
      const cb = this.#pending.get(msg.id);
      if (cb) {
        this.#pending.delete(msg.id);
        cb(msg);
      }
    });
  }

  /** Evaluate one transform tail (e.g. `ds.isel(time=0)`) and resolve with its structure. */
  eval(code: string): Promise<OracleResult> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const onExit = () =>
        reject(new Error(`oracle exited before replying to #${id}. stderr:\n${this.#stderr}`));
      this.#proc.once("exit", onExit);
      this.#pending.set(id, (r) => {
        this.#proc.removeListener("exit", onExit);
        resolve(r);
      });
      this.#proc.stdin.write(`${JSON.stringify({ id, code })}\n`);
    });
  }

  /** Captured stderr, for diagnosing a crash. */
  get stderr(): string {
    return this.#stderr;
  }

  /** Shut the subprocess down. */
  close(): void {
    this.#rl.close();
    this.#proc.stdin.end();
    this.#proc.kill();
  }
}
