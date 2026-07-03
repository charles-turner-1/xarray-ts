/**
 * Client-side upgrade for {@link RunnableCell.astro}: mount a CodeMirror editor
 * over each cell's fallback source and wire its Run button to {@link runCell}.
 * Framework-free — plain DOM, matching the library's zero-framework ethos.
 */
import { preloadPlayground, runCell, type RunResult } from "./runner";
import "./RunnableCell.css";

/** Find every not-yet-initialised cell on the page and upgrade it. Idempotent. */
export function setupRunnableCells(): void {
  document
    .querySelectorAll<HTMLElement>("[data-rc]:not([data-rc-ready])")
    .forEach((cell) => void initCell(cell));
}

async function initCell(root: HTMLElement): Promise<void> {
  root.setAttribute("data-rc-ready", "");

  const editorHost = root.querySelector<HTMLElement>(".rc-editor")!;
  const fallback = editorHost.querySelector<HTMLElement>(".rc-fallback");
  const runBtn = root.querySelector<HTMLButtonElement>(".rc-run")!;
  const output = root.querySelector<HTMLElement>(".rc-output")!;
  const initialCode = (fallback?.textContent ?? "").replace(/\n+$/, "");

  // Warm the bundle on first hover so the first Run feels instant.
  root.addEventListener("pointerenter", preloadPlayground, { once: true });

  let getCode = () => initialCode;

  try {
    const [{ EditorView, basicSetup }, { javascript }, { oneDark }] = await Promise.all([
      import("codemirror"),
      import("@codemirror/lang-javascript"),
      import("@codemirror/theme-one-dark"),
    ]);
    const view = new EditorView({
      doc: initialCode,
      extensions: [basicSetup, javascript({ typescript: true }), oneDark, EditorView.lineWrapping],
      parent: editorHost,
    });
    fallback?.remove();
    getCode = () => view.state.doc.toString();
  } catch {
    // Editor failed to load — leave the read-only source visible and still allow Run.
  }

  runBtn.addEventListener("click", async () => {
    const label = runBtn.textContent;
    runBtn.disabled = true;
    runBtn.textContent = "Running…";
    try {
      renderOutput(output, await runCell(getCode()));
    } finally {
      runBtn.disabled = false;
      runBtn.textContent = label;
    }
  });
}

function renderOutput(container: HTMLElement, result: RunResult): void {
  container.hidden = false;
  container.replaceChildren();

  for (const line of result.logs) {
    container.append(pre(`rc-log rc-log-${line.level}`, line.text));
  }
  if (result.result !== undefined) container.append(pre("rc-result", result.result));
  if (result.error) container.append(pre("rc-error", result.error));
  if (!result.logs.length && result.result === undefined && !result.error) {
    container.append(pre("rc-empty", "✓ ran (no output)"));
  }
}

function pre(className: string, text: string): HTMLPreElement {
  const el = document.createElement("pre");
  el.className = className;
  el.textContent = text;
  return el;
}
