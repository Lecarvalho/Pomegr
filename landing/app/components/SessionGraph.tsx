import styles from "./LandingPage.module.css";

const WIDTH = 1100;
const HEIGHT = 220;
const TAU = Math.PI * 2;

// One period of two smooth, invented activity curves. Every term repeats exactly over WIDTH, so
// paths drawn across two periods loop without a seam when they scroll by one period.
const main = (x: number) => {
  const t = (x / WIDTH) * TAU;
  return 0.5 + 0.22 * Math.sin(t + 0.6) + 0.12 * Math.sin(3 * t + 1.9) + 0.07 * Math.sin(5 * t + 0.4) + 0.04 * Math.sin(9 * t + 2.2);
};
const helper = (x: number) => {
  const t = (x / WIDTH) * TAU;
  return 0.24 + 0.08 * Math.sin(2 * t + 2.8) + 0.05 * Math.sin(4 * t + 0.3) + 0.03 * Math.sin(7 * t + 1.1);
};

const y = (curve: (x: number) => number) => (x: number) => (HEIGHT - 16 - curve(x) * (HEIGHT - 48)).toFixed(1);
const xs = Array.from({ length: (WIDTH * 2) / 10 + 1 }, (_, index) => index * 10);
const line = (curve: (x: number) => number) => `M${xs.map((x) => `${x} ${y(curve)(x)}`).join(" L")}`;
const MAIN = line(main);
const AREA = `${MAIN} L${WIDTH * 2} ${HEIGHT} L0 ${HEIGHT} Z`;
const HELPER = line(helper);
// Event ticks along the floor, at fixed places in the period so they loop with the curves.
const EVENTS = [64, 132, 150, 241, 355, 372, 391, 508, 590, 611, 702, 778, 846, 861, 950, 1032];
const TICKS = [...EVENTS, ...EVENTS.map((x) => x + WIDTH)].map((x) => `M${x} ${HEIGHT - 10} V${HEIGHT}`).join(" ");

// fig. 1: a session's activity as one red curve over a fading fill of the same red, a quieter
// helper line, and event ticks, scrolling slowly forever behind fixed grid lines and a Now mark.
export function SessionGraph() {
  return (
    <div className={styles.sessionGraph} aria-hidden="true">
      <div className={styles.sessionGrid}><i /><i /><i /></div>
      <svg viewBox={`0 0 ${WIDTH * 2} ${HEIGHT}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id="session-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#e5675b" stopOpacity=".3" />
            <stop offset="1" stopColor="#e5675b" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={AREA} fill="url(#session-fill)" />
        <path className={styles.sessionHelper} d={HELPER} />
        <path className={styles.sessionTicks} d={TICKS} />
        <path className={styles.sessionLine} d={MAIN} />
      </svg>
      <span className={styles.sessionNow}>Now</span>
    </div>
  );
}
