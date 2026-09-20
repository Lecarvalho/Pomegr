"use client";

/** Panel heading that opens the fuller view of the same evidence. Composes the quiet action role. */
export function PanelHeadingLink({ id, children, onOpen }: { id: string; children: string; onOpen: () => void }) {
  return <h2 id={id} className="panelHeading">
    <button type="button" className="commandQuietAction panelHeadingLink" onClick={onOpen}>
      {children}
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M6 3l5 5-5 5" /></svg>
    </button>
  </h2>;
}
