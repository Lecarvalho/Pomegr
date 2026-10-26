/** One measured value with the number of Done tasks it was computed from. `value` is null when no task gave it. */
export type ScorecardValue = { value: number | null; sample: number };

export type ScorecardMeasures = {
  /** S1: median owner turns in the task's sessions after Review, over merged tasks. */
  ownerTurns: ScorecardValue;
  /** S1: median milliseconds from Review to Done, over merged tasks. */
  reviewToDoneMs: ScorecardValue;
  /** S2: share (0 to 1) of merged tasks with no commit after Review. */
  firstPass: ScorecardValue;
  /** S8: share (0 to 1) of merged tasks with declared or recorded rework; lower is better. */
  reworkRate: ScorecardValue;
};

export type ScorecardSnapshot = { version: string; takenAt: number; measures: ScorecardMeasures };

/** A repository's scorecard: the current values, and the first snapshot as the baseline (null until a later version). */
export type Scorecard = { formula: number; current: ScorecardSnapshot; baseline: ScorecardSnapshot | null };

export type ScorecardRow = {
  id: string;
  label: string;
  caption: string;
  now: string | null;
  baseline: string | null;
  sample: number | null;
  /** Why a row has no source yet. */
  pending?: string;
};

const turns = (entry: ScorecardValue) => entry.value === null ? null : `${Number.isInteger(entry.value) ? entry.value : entry.value.toFixed(1)} ${entry.value === 1 ? "turn" : "turns"}`;
const share = (entry: ScorecardValue) => entry.value === null ? null : `${Math.round(entry.value * 100)}%`;

export function duration(entry: ScorecardValue) {
  if (entry.value === null) return null;
  const minutes = Math.round(entry.value / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
  return `${Math.round(hours / 24)} days`;
}

const UNMEASURED: readonly Omit<ScorecardRow, "now" | "baseline" | "sample">[] = [
  { id: "S3", label: "Proof present", caption: "Pull requests with the proof their template asks for.", pending: "Measured once G4 ships." },
  { id: "S4", label: "Silent failures", caption: "Tasks that stopped with no state change or report.", pending: "Measured once G5 ships." },
  { id: "S5", label: "Manual closeouts", caption: "Merged tasks still open somewhere a day after the merge.", pending: "Measured once G12 ships." },
  { id: "S6", label: "Model reasons", caption: "Starts with a recorded reason for their model.", pending: "Measured once G6 ships." },
  { id: "S7", label: "Interventions while away", caption: "Revoked grants and needs-you items during an absence.", pending: "Measured during an absence experiment." },
];

/** The panel's rows, in scorecard order. */
export function scorecardRows(card: Scorecard): ScorecardRow[] {
  const base = card.baseline?.measures ?? null;
  const now = card.current.measures;
  return [
    { id: "S1", label: "Owner turns after Review", caption: "Median, per merged task.", now: turns(now.ownerTurns), baseline: base && turns(base.ownerTurns), sample: now.ownerTurns.sample },
    { id: "S1", label: "Review to Done", caption: "Median time, per merged task.", now: duration(now.reviewToDoneMs), baseline: base && duration(base.reviewToDoneMs), sample: now.reviewToDoneMs.sample },
    { id: "S2", label: "First-pass acceptance", caption: "Merged tasks with no commit after Review.", now: share(now.firstPass), baseline: base && share(base.firstPass), sample: now.firstPass.sample },
    { id: "S8", label: "Rework rate", caption: "Merged tasks sent back, failed a review, requeued, or named by a rework link. Lower is better.", now: share(now.reworkRate), baseline: base && share(base.reworkRate), sample: now.reworkRate.sample },
    ...UNMEASURED.map((row) => ({ ...row, now: null, baseline: null, sample: null })),
  ];
}

export type ScorecardAnswer = { ok: true; scorecard: Scorecard } | { ok: false };

const record = (value: unknown): Record<string, unknown> | null => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
const version = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 40 ? value : null;

function measure(value: unknown): ScorecardValue | null {
  const entry = record(value);
  if (!entry || !Number.isSafeInteger(entry.sample) || (entry.sample as number) < 0) return null;
  if (entry.value === null) return { value: null, sample: entry.sample as number };
  return typeof entry.value === "number" && Number.isFinite(entry.value) && entry.value >= 0 ? { value: entry.value, sample: entry.sample as number } : null;
}

function snapshot(value: unknown): ScorecardSnapshot | null {
  const entry = record(value);
  const measures = record(entry?.measures);
  if (!entry || !measures || !version(entry.version) || !Number.isSafeInteger(entry.takenAt)) return null;
  const ownerTurns = measure(measures.ownerTurns);
  const reviewToDoneMs = measure(measures.reviewToDoneMs);
  const firstPass = measure(measures.firstPass);
  const reworkRate = measure(measures.reworkRate);
  if (!ownerTurns || !reviewToDoneMs || !firstPass || !reworkRate
    || (firstPass.value !== null && firstPass.value > 1) || (reworkRate.value !== null && reworkRate.value > 1)) return null;
  return { version: entry.version as string, takenAt: entry.takenAt as number, measures: { ownerTurns, reviewToDoneMs, firstPass, reworkRate } };
}

/** The bridge's answer as a scorecard, or null when any part is malformed. */
export function parseScorecard(value: unknown): Scorecard | null {
  const entry = record(value);
  if (!entry || !Number.isSafeInteger(entry.formula)) return null;
  const current = snapshot(entry.current);
  const baseline = entry.baseline === null ? null : snapshot(entry.baseline);
  if (!current || (entry.baseline !== null && !baseline)) return null;
  return { formula: entry.formula as number, current, baseline };
}
