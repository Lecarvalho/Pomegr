// Where the composer block of Home stands in focus mode on a phone. The block is placed before the keyboard opens, above the place the keyboard will take, and it does not
// move again while the keyboard is open (docs/internal/design/home.md, Focus mode › Phone). Following the keyboard moves a fixed block with the browser's own pan of the
// visual viewport, so the block bumps toward the top of the screen; moving it at once on the resize jumps it. Predicting the keyboard avoids both. The prediction is the
// height the keyboard had the last time on this device, which this module keeps in browser storage as one number, or else a share of the screen.

/** The key of the last measured keyboard height, in pixels. It is a per-device convenience: one number, never content, and the page works without it. */
export const KEYBOARD_STORAGE_KEY = "pomegr.home.keyboardHeight";
/** The share of the screen a keyboard takes where none was measured yet. It was 264px of 696px on a phone (38%). */
export const KEYBOARD_FALLBACK_RATIO = 0.38;
/** A shrink of the visual viewport that is not larger than this is a browser bar, not a keyboard. */
export const KEYBOARD_MIN_PX = 120;
/** The space between the block and the top of the keyboard. */
export const KEYBOARD_GAP_PX = 16;
/** The space between the header and the block when the block is held down by the header (`--space-3`). */
export const HEADER_GAP_PX = 12;

const isKeyboard = (height: number, screen: number) => Number.isFinite(height) && height > KEYBOARD_MIN_PX && height < screen;

/** The keyboard height this device last had, or null where none was kept or it cannot be read. */
export function readKeyboardHeight(screen: number): number | null {
  try {
    const height = Number(window.localStorage.getItem(KEYBOARD_STORAGE_KEY));
    return isKeyboard(height, screen) ? Math.round(height) : null;
  } catch {
    return null;
  }
}

/** Keeps a measured keyboard height for the next time. A height that no keyboard has is not kept. Returns whether it was kept. */
export function storeKeyboardHeight(height: number, screen: number): boolean {
  if (!isKeyboard(height, screen)) return false;
  try {
    window.localStorage.setItem(KEYBOARD_STORAGE_KEY, String(Math.round(height)));
    return true;
  } catch {
    return false;
  }
}

/** The height the keyboard is expected to have: the last one measured on this device, else a share of the screen. */
export function predictedKeyboardHeight(screen: number): number {
  return readKeyboardHeight(screen) ?? Math.round(KEYBOARD_FALLBACK_RATIO * screen);
}

/** What the screen and the block are, in pixels, when focus mode starts. */
export type FocusPlaceInput = {
  /** The height of the layout viewport, which the keyboard does not shrink. */
  screen: number;
  /** The height the keyboard is expected to have. */
  keyboard: number;
  /** The height of the block, as it is in focus mode. */
  block: number;
  /** The bottom edge of the header, or 0 where there is none. */
  headerBottom: number;
  /** The top of the block in its resting place, before focus mode, or null where it was not measured. */
  restTop: number | null;
};

/**
 * Where the block starts: its bottom edge a gap above the keyboard's top edge. It is never below the block's resting place, so focus mode never lowers the block, and
 * it is never under the header, which wins where a block is too tall for both. The block is held by its bottom edge (`focusBottom`), so this is only where its top
 * begins; the top moves up as the block grows.
 */
export function focusTop({ screen, keyboard, block, headerBottom, restTop }: FocusPlaceInput): number {
  const above = screen - keyboard - block - KEYBOARD_GAP_PX;
  const high = restTop === null ? above : Math.min(above, restTop);
  return Math.round(Math.max(high, headerBottom + HEADER_GAP_PX));
}

/**
 * The distance from the bottom of the screen to the bottom edge of the block, which the block keeps (`bottom` of the fixed block): the screen less where the block ends, that is
 * its starting top plus its height. The block starts exactly where `focusTop` puts it, and a taller block then grows upward, because its bottom edge does not move.
 */
export function focusBottom(place: FocusPlaceInput): number {
  return Math.round(place.screen - (focusTop(place) + place.block));
}

/**
 * The tallest the block may grow: from its bottom edge up to a gap under the header. A block taller than that would go under the header, so the block stops growing here and its
 * message field scrolls (HomeAril.module.css). It is never less than the block at the start, which is the case where the header already holds the block down.
 */
export function focusMaxHeight(place: FocusPlaceInput): number {
  const room = place.screen - focusBottom(place) - (place.headerBottom + HEADER_GAP_PX);
  return Math.max(Math.ceil(place.block), Math.round(room));
}
