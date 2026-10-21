// The 14px stroke glyphs of the task modal. Each one is decorative: the words beside it carry the meaning.

const glyph = { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, focusable: "false" } as const;

export function LockGlyph() {
  return <svg {...glyph} strokeWidth={1.4}><rect x="3.5" y="7" width="9" height="6.5" rx="1" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></svg>;
}

export function CheckGlyph() {
  return <svg {...glyph} strokeWidth={1.75}><path d="M3 8.5l3.2 3L13 5" /></svg>;
}

export function RingGlyph() {
  return <svg {...glyph} strokeWidth={1.5}><circle cx="8" cy="8" r="5" /></svg>;
}

export function ImageGlyph() {
  return <svg {...glyph} strokeWidth={1.4}><rect x="2.5" y="3" width="11" height="10" rx="1" /><circle cx="6" cy="6.5" r="1" /><path d="M13.5 10.5l-3-3-6 5.5" /></svg>;
}
