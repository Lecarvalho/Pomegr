"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { WARM_DEBOUNCE_MS, threadAgentChat, warmAgentChat } from "../../agent-chat-client";
import { useRepositoryInventory } from "../../repository-inventory-client";
import { AgentChatComposer, type AgentChatComposerHandle } from "../agent-chat/AgentChatComposer";
import {
  HOME_COMPOSER_FIELD_ID, chooseRepository, readStoredRepository, sendAgentChatFromHome, storeRepository,
} from "../agent-chat/agent-chat-presentation";
import { CHAT_DEFAULT_EFFORT, chatModelOptions, chatModelValue, initialChatRun, type ChatRunSource } from "../agent-chat/agent-chat-run";
import { useAgentChatComposer } from "../agent-chat/useAgentChatComposer";
import type { CommandSelectOption } from "../command-center/CommandSelect";
import { NO_MODELS } from "../tasks/task-fields";
import styles from "./HomeAril.module.css";

/** Home is in one of three modes: its parts, the composer lifted to the middle (focus), or the thread the message was handed to. */
export type HomeMode = "home" | "focus" | "thread";

const PHONE = "(max-width: 760px)";
const phone = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(PHONE).matches;

/** The run the repository's thread last used, read once for each repository the composer shows. It is only the composer's first model and effort. */
function useThreadRun(repositoryId: string): { run: ChatRunSource | null; ready: boolean } {
  const [read, setRead] = useState<{ repositoryId: string; run: ChatRunSource | null } | null>(null);
  useEffect(() => {
    let live = true;
    void threadAgentChat(repositoryId).then((answer) => { if (live) setRead({ repositoryId, run: answer.ok ? answer.run : null }); });
    return () => { live = false; };
  }, [repositoryId]);
  const current = read !== null && read.repositoryId === repositoryId;
  return { run: current ? read.run : null, ready: current };
}

/**
 * While the composer is lifted (focus mode and the thread after it), shifts the block to the vertical middle of the content area: the shift is
 * measured from the block's own place in the page, so the page does not move. The block returns when Home does. On a phone the block is fixed to
 * the bottom instead, and there is no shift.
 */
function useFocusShift(block: RefObject<HTMLElement | null>, lifted: boolean) {
  const shift = useRef(0);
  useLayoutEffect(() => {
    const element = block.current;
    if (!element) return;
    const apply = () => {
      if (!lifted || phone()) { shift.current = 0; element.style.setProperty("--focus-shift", "0px"); return; }
      const area = (element.closest(".commandMain") ?? document.documentElement).getBoundingClientRect();
      const rect = element.getBoundingClientRect();
      const natural = rect.top - shift.current;
      shift.current = area.top + (area.height - rect.height) / 2 - natural;
      element.style.setProperty("--focus-shift", `${Math.round(shift.current)}px`);
    };
    apply();
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  }, [block, lifted]);
}

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
const quiet = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(REDUCED_MOTION).matches;

/** The time constant of the ease that brings the block to a new height of the visual viewport. After four of them (360ms) it is within 2% of its place. */
const EASE_MS = 90;
/** The block follows the visual viewport on every frame until it has stood still for this many frames (half a second), so a viewport that moves without an event is still followed. */
const STILL_FRAMES = 30;

/**
 * On a phone in focus mode, places the block against the visual viewport, so it stays just above the keyboard however the browser moves the viewport (T-219).
 * The bottom edge of the block is the bottom edge of the visual viewport, less the gap. Only the visual viewport decides it: `--viewport-bottom` is its `offsetTop` plus
 * the height the block has eased to, `top` is made of it, and the style sheet lifts the block by its own height. The layout viewport and `innerHeight` are never read, so a
 * frame in which they disagree with the visual viewport moves nothing.
 * A pan of the visual viewport (the browser scrolls the focused field into view, and a fixed block moves on the screen with the viewport that is panned over it) is
 * followed in the frame of its event, with no ease, so the block does not move at all. Only the height is eased, in screen space, so one step of the keyboard or many
 * resizes while it animates are one move to the final place that never goes past it.
 */
function useViewportAnchor(block: RefObject<HTMLElement | null>, active: boolean) {
  useLayoutEffect(() => {
    const element = block.current;
    const viewport = typeof window === "undefined" ? null : window.visualViewport;
    if (!active || !element || !viewport || !phone()) return;
    const instant = quiet();
    // Where the bottom edge of the block is on the screen, measured from the top of the visual viewport. It starts where the block is: at the foot of what is visible.
    let shown = viewport.height;
    let frame = 0;
    let still = 0;
    let lastTop = viewport.offsetTop;
    let lastAt = 0;
    const place = () => element.style.setProperty("--viewport-bottom", `${(viewport.offsetTop + shown).toFixed(2)}px`);
    const run = (now: number) => {
      frame = 0;
      const target = viewport.height;
      const from = shown;
      const elapsed = lastAt === 0 ? 16 : Math.min(now - lastAt, 50);
      lastAt = now;
      shown = instant || Math.abs(shown - target) < 0.5 ? target : target + (shown - target) * Math.exp(-elapsed / EASE_MS);
      place();
      still = shown === from && viewport.offsetTop === lastTop ? still + 1 : 0;
      lastTop = viewport.offsetTop;
      if (still < STILL_FRAMES) frame = window.requestAnimationFrame(run);
      else lastAt = 0;
    };
    const follow = () => {
      if (instant) shown = viewport.height;
      place();
      still = 0;
      if (frame === 0) frame = window.requestAnimationFrame(run);
    };
    place();
    frame = window.requestAnimationFrame(run);
    viewport.addEventListener("resize", follow);
    viewport.addEventListener("scroll", follow);
    window.addEventListener("resize", follow);
    return () => {
      window.cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", follow);
      viewport.removeEventListener("scroll", follow);
      window.removeEventListener("resize", follow);
      element.style.removeProperty("--viewport-bottom");
    };
  }, [block, active]);
}

/** The suggestion chips above the composer. A chip fills the message field and sends nothing. */
export function HomeChips({ suggestions, onPick }: { suggestions: readonly string[]; onPick(text: string): void }) {
  if (suggestions.length === 0) return null;
  return <div className={styles.chips}>
    <ul className={styles.chipList} aria-label="Suggestions">
      {suggestions.map((text) => <li key={text}>
        <button type="button" className="commandQuietAction agentChatSuggestionChip" onClick={() => onPick(text)}>{text}</button>
      </li>)}
    </ul>
  </div>;
}

/** The block of the chips and the composer in one of Home's modes, with the hint under it in focus mode and, on a phone, a way back. */
export function HomeComposerShell({ mode, onLeave, shellRef, children }: { mode: HomeMode; onLeave?: () => void; shellRef?: RefObject<HTMLElement | null>; children: ReactNode }) {
  return <section ref={shellRef} className={`agentChatHome ${styles.aril}${mode === "focus" ? ` ${styles.isFocus}` : mode === "thread" ? ` ${styles.isThread}` : ""}`} aria-label="Ask Aril">
    {children}
    <p className={styles.hint} aria-hidden={mode !== "focus"}>Enter to send · Esc to go back</p>
    {mode === "focus" && onLeave && <button type="button" className={`commandQuietAction ${styles.back}`} onClick={onLeave}>Back to Home</button>}
  </section>;
}

type Focus = { block: RefObject<HTMLElement | null>; onFocus(): void; onSent(): void; onEmptyChange(empty: boolean): void };

/** The chat composer for one repository, drawn on Home. Send hands the message to the dock, which opens the maximized panel and sends it there. */
function HomeComposer({ repositoryId, repositories, onRepositoryChange, suggestions, focus }: {
  repositoryId: string;
  repositories: ReadonlyArray<CommandSelectOption>;
  onRepositoryChange(repositoryId: string): void;
  suggestions: readonly string[];
  focus: Focus;
}) {
  const thread = useThreadRun(repositoryId);
  const state = useAgentChatComposer(repositoryId, thread.run);
  const { run, draft, setDraft, attached, setAttached, setImageError } = state;
  const composer = useRef<AgentChatComposerHandle>(null);
  const { block, onFocus, onSent, onEmptyChange } = focus;

  // A field that keeps its focus asks the desktop to keep a provider run ready for the next message, as the panel's does: once for a
  // burst of focus events, with the run the composer shows, and only after the thread was read so that the run is the thread's.
  const [focused, setFocused] = useState(false);
  const { ready } = thread;
  useEffect(() => {
    if (!focused || !ready) return;
    const timer = window.setTimeout(() => { void warmAgentChat(repositoryId, run.provider, run.model, run.effort); }, WARM_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [focused, ready, repositoryId, run.provider, run.model, run.effort]);

  // Home needs to know whether the field is empty, to decide what a click outside does.
  const empty = draft === "" && attached.length === 0;
  useEffect(() => { onEmptyChange(empty); }, [empty, onEmptyChange]);

  const send = () => {
    const text = draft.trim();
    if (text === "") return;
    // Where the composer is on the screen now, so the panel's composer can settle from there to the bottom.
    const fromTop = block.current?.querySelector<HTMLElement>(".agentChatComposer")?.getBoundingClientRect().top;
    sendAgentChatFromHome({ repositoryId, text, provider: run.provider, model: run.model, effort: run.effort, images: attached, ...(fromTop !== undefined ? { fromTop } : {}) });
    setDraft("");
    setAttached([]);
    setImageError(null);
    onSent();
  };

  return <>
    <div className={styles.chipBlock}><div className={styles.chipInner}><HomeChips suggestions={suggestions} onPick={(text) => { setDraft(text); onFocus(); composer.current?.focus(); }} /></div></div>
    <AgentChatComposer ref={composer} fieldId={HOME_COMPOSER_FIELD_ID} value={draft} onChange={setDraft} onSend={send} onStop={() => undefined}
      onFieldFocusChange={(focusedNow) => { setFocused(focusedNow); if (focusedNow) onFocus(); }}
      modelOptions={state.modelOptions} modelValue={state.modelValue} onModelChange={state.chooseModel} effort={run.effort} onEffortChange={state.chooseEffort}
      repositories={repositories} repositoryId={repositoryId} onRepositoryChange={onRepositoryChange}
      running={false} busy={false} error={null}
      images={attached.map((image) => image.id)} imageUrls={state.imageUrls} uploading={state.uploading} imageError={state.imageError}
      onAttach={(files) => { void state.attach(files); }} onRemoveImage={state.removeImage} />
  </>;
}

/** The composer is disabled while no repository can be chosen: the inventory is loading, or Pomegr has observed none. */
function HomeComposerWithoutRepository({ loading }: { loading: boolean }) {
  const options = useMemo(() => chatModelOptions(NO_MODELS, initialChatRun(NO_MODELS, null)), []);
  return <>
    <p className={styles.note} role="status">{loading ? "Loading repositories…" : "No repositories observed yet."}</p>
    <AgentChatComposer fieldId={HOME_COMPOSER_FIELD_ID} value="" onChange={() => undefined} onSend={() => undefined} onStop={() => undefined}
      modelOptions={options} modelValue={chatModelValue(initialChatRun(NO_MODELS, null))} onModelChange={() => undefined}
      effort={CHAT_DEFAULT_EFFORT} onEffortChange={() => undefined} disabled running={false} busy={false} error={null} />
  </>;
}

/**
 * The suggestions and the composer at the foot of Home, drawn only where the chat can be reached. Focusing the composer, or picking a chip, enters
 * focus mode (Home's other parts fade out and this block moves to the middle); Send hands the page to the maximized panel.
 */
export function HomeAril({ suggestions, mode, blockRef, onFocus, onSent, onLeave, onEmptyChange }: {
  suggestions: readonly string[];
  mode: HomeMode;
  /** The block's ref when its owner glides it between its places on a phone (useComposerGlide); without one the block keeps its own. */
  blockRef?: RefObject<HTMLElement | null>;
  onFocus(): void;
  onSent(): void;
  onLeave(): void;
  onEmptyChange(empty: boolean): void;
}) {
  const { snapshot, loading } = useRepositoryInventory();
  const ids = useMemo(() => snapshot.repositories.map((repository) => repository.id), [snapshot.repositories]);
  const options = useMemo<CommandSelectOption[]>(() => snapshot.repositories.map((repository) => ({ value: repository.id, label: repository.displayName })), [snapshot.repositories]);
  const [selected, setSelected] = useState<string | null>(null);
  // The last repository used, else the first listed, until the owner chooses one here.
  const fallback = useMemo(() => chooseRepository(ids, null, readStoredRepository()), [ids]);
  const repositoryId = selected !== null && ids.includes(selected) ? selected : fallback;
  const choose = (id: string) => { storeRepository(id); setSelected(id); };
  const ownBlock = useRef<HTMLElement>(null);
  const block = blockRef ?? ownBlock;
  useFocusShift(block, mode !== "home");
  useViewportAnchor(block, mode === "focus");

  return <HomeComposerShell mode={mode} onLeave={onLeave} shellRef={block}>
    {repositoryId === null
      ? <HomeComposerWithoutRepository loading={loading && ids.length === 0} />
      : <HomeComposer repositoryId={repositoryId} repositories={options} onRepositoryChange={choose} suggestions={suggestions} focus={{ block, onFocus, onSent, onEmptyChange }} />}
  </HomeComposerShell>;
}
