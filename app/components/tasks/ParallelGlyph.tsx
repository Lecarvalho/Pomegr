/** The parallel mark: two vertical strokes. With a `label` it is an image with that name, otherwise it is decoration. */
export function ParallelGlyph({ label }: { label?: string }) {
  return <svg className="taskParallelGlyph" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" focusable="false"
    {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}>
    <path d="M4 2v8M8 2v8" />
  </svg>;
}
