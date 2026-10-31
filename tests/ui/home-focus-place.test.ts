import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KEYBOARD_FALLBACK_RATIO, KEYBOARD_STORAGE_KEY, focusTop, predictedKeyboardHeight, readKeyboardHeight, storeKeyboardHeight,
} from "../../app/components/home/focus-place";

// Where the composer block of Home stands in focus mode on a phone. The numbers are the owner's phone, measured through remote DevTools (T-219): a layout viewport of 696px, a
// keyboard of 264px (38% of it), and a block of 232px, which put the top of the block at 184px with a 16px gap above the keyboard.
const SCREEN = 696;
const KEYBOARD = 264;
const BLOCK = 232;

afterEach(() => {
  window.localStorage.removeItem(KEYBOARD_STORAGE_KEY);
  vi.restoreAllMocks();
});

describe("the keyboard height Home remembers on this device", () => {
  it("reads a height that was stored, and falls back to a share of the screen where none was", () => {
    expect(readKeyboardHeight(SCREEN)).toBeNull();
    expect(predictedKeyboardHeight(SCREEN)).toBe(Math.round(KEYBOARD_FALLBACK_RATIO * SCREEN));
    expect(predictedKeyboardHeight(SCREEN)).toBe(KEYBOARD);
    expect(predictedKeyboardHeight(800)).toBe(304);
    window.localStorage.setItem(KEYBOARD_STORAGE_KEY, "301");
    expect(readKeyboardHeight(SCREEN)).toBe(301);
    expect(predictedKeyboardHeight(SCREEN)).toBe(301);
  });

  it("keeps one rounded number under one key, and nothing but a number", () => {
    expect(KEYBOARD_STORAGE_KEY).toBe("pomegr.home.keyboardHeight");
    expect(storeKeyboardHeight(263.6, SCREEN)).toBe(true);
    expect(window.localStorage.getItem(KEYBOARD_STORAGE_KEY)).toBe("264");
    expect(window.localStorage.length).toBe(1);
  });

  it.each([["a word", "keyboard"], ["nothing", ""], ["a bar's worth", "56"], ["the screen", String(SCREEN)], ["more than the screen", "9000"], ["a negative", "-264"], ["infinity", "Infinity"]])(
    "does not trust %s, and predicts from the screen",
    (_, stored) => {
      window.localStorage.setItem(KEYBOARD_STORAGE_KEY, stored);
      expect(readKeyboardHeight(SCREEN)).toBeNull();
      expect(predictedKeyboardHeight(SCREEN)).toBe(KEYBOARD);
    },
  );

  it.each([["a browser bar", 56], ["the threshold itself", 120], ["no shrink", 0], ["the whole screen", SCREEN], ["not a number", Number.NaN]])("does not keep %s as a keyboard", (_, height) => {
    expect(storeKeyboardHeight(height, SCREEN)).toBe(false);
    expect(window.localStorage.getItem(KEYBOARD_STORAGE_KEY)).toBeNull();
  });

  it("works where browser storage cannot be read or written", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(readKeyboardHeight(SCREEN)).toBeNull();
    expect(predictedKeyboardHeight(SCREEN)).toBe(KEYBOARD);
    expect(storeKeyboardHeight(KEYBOARD, SCREEN)).toBe(false);
  });
});

describe("the top of the block in focus mode", () => {
  const place = (overrides: Partial<Parameters<typeof focusTop>[0]> = {}) => focusTop({ screen: SCREEN, keyboard: KEYBOARD, block: BLOCK, headerBottom: 56, restTop: 460, ...overrides });

  it("puts the bottom of the block 16px above the top of the keyboard: the owner's phone gives 184px", () => {
    expect(place()).toBe(184);
    expect(place()).toBe(SCREEN - KEYBOARD - BLOCK - 16);
  });

  it("follows the keyboard height it is given, a stored one or the fallback, and the screen", () => {
    expect(place({ keyboard: 301 })).toBe(SCREEN - 301 - BLOCK - 16);
    expect(place({ keyboard: predictedKeyboardHeight(800), screen: 800, restTop: 600 })).toBe(800 - 304 - BLOCK - 16);
    expect(place({ block: 180 })).toBe(SCREEN - KEYBOARD - 180 - 16);
  });

  it("is never below the resting place of the block, so focus mode never lowers it", () => {
    expect(place({ restTop: 120 })).toBe(120);
    expect(place({ restTop: 150, headerBottom: 0 })).toBe(150);
    expect(place({ restTop: 184 })).toBe(184);
    expect(place({ restTop: null })).toBe(184);
  });

  it("is never under the header: it stops 12px below the header's bottom edge, however tall the keyboard", () => {
    expect(place({ keyboard: 600 })).toBe(56 + 12);
    expect(place({ keyboard: 600, headerBottom: 0 })).toBe(12);
    expect(place({ block: 700 })).toBe(68);
  });

  it("lets the header win where it and the resting place disagree", () => {
    expect(place({ restTop: 20 })).toBe(68);
  });

  it("is a whole number of pixels", () => {
    expect(Number.isInteger(place({ block: 231.6 }))).toBe(true);
  });
});
