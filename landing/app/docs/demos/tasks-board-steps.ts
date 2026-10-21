// The scripted board of the Tasks guide demo. Every task is invented; the demo starts nothing and calls no API.

export type DemoColumn = "Backlog" | "Ready" | "In progress" | "Review" | "Done";

export const DEMO_COLUMNS: readonly DemoColumn[] = ["Backlog", "Ready", "In progress", "Review", "Done"];

export interface DemoCard {
  id: string;
  title: string;
  /** The state chip. The board draws it only where the lane does not already say the state, so the demo has one: Next, on the card that starts next in Ready. */
  chip?: "Next";
  /** The task needs the owner, so its border is amber on the board. The lane, Review, says why. */
  attention?: boolean;
  /** Cards that share a group id are drawn in one Parallel frame. */
  group?: string;
  /** A muted line under the title, such as a wait reason. */
  note?: string;
}

export interface DemoProposal {
  operation: string;
  text: string;
  applied: boolean;
}

export interface DemoStep {
  /** The control the reader selects to reach the next step, in the app's own words. */
  action: string;
  /** One short caption for the board as it now reads. */
  caption: string;
  queueOn: boolean;
  columns: Record<DemoColumn, DemoCard[]>;
  proposal: DemoProposal | null;
  /** Card IDs that changed in this step, for a brief highlight. */
  changed: readonly string[];
}

const T1 = { id: "T-1", title: "Add a dark theme toggle" };
const T2 = { id: "T-2", title: "Fix the date format on invoices" };
const T3 = { id: "T-3", title: "Translate the settings page" };
const T4 = { id: "T-4", title: "Rename the export button" };
const T5 = { id: "T-5", title: "Write tests for the CSV export" };
const PROPOSAL_TEXT = T5.title;

const empty = (): Record<DemoColumn, DemoCard[]> => ({ Backlog: [], Ready: [], "In progress": [], Review: [], Done: [] });

function board(columns: Partial<Record<DemoColumn, DemoCard[]>>) {
  return { ...empty(), ...columns };
}

export const DEMO_STEPS: readonly DemoStep[] = [
  {
    action: "New task",
    caption: "This is a demo with sample tasks, not the Pomegr app. It starts nothing.",
    queueOn: false,
    columns: board({ Backlog: [T1, T2, T3] }),
    proposal: null,
    changed: [],
  },
  {
    action: "Add to queue",
    caption: "Create task puts the new card in Backlog, not queued.",
    queueOn: false,
    columns: board({ Backlog: [T1, T2, T3, T4] }),
    proposal: null,
    changed: [T4.id],
  },
  {
    action: "Run in parallel",
    caption: "Add to queue moves a card to Ready. Ready starts from the top, one card at a time.",
    queueOn: false,
    columns: board({
      Backlog: [T4],
      Ready: [{ ...T1, chip: "Next" }, T2, T3],
    }),
    proposal: null,
    changed: [T1.id, T2.id, T3.id],
  },
  {
    action: "Queue: On",
    caption: "Run in parallel puts T-2 and T-3 in one group. The group starts together.",
    queueOn: false,
    columns: board({
      Backlog: [T4],
      Ready: [{ ...T1, chip: "Next" }, { ...T2, group: "g" }, { ...T3, group: "g" }],
    }),
    proposal: null,
    changed: [T2.id, T3.id],
  },
  {
    action: "Continue",
    caption: "The queue is On. It starts the top card, T-1. The group waits until T-1 is in Review.",
    queueOn: true,
    columns: board({
      Backlog: [T4],
      Ready: [
        { ...T2, group: "g", note: "Waiting: T-1 is running" },
        { ...T3, group: "g", note: "Waiting: T-1 is running" },
      ],
      "In progress": [T1],
    }),
    proposal: null,
    changed: [T1.id],
  },
  {
    action: "Ask Aril",
    caption: "T-1's agent reported the work complete, so T-1 is in Review. The group starts.",
    queueOn: true,
    columns: board({
      Backlog: [T4],
      "In progress": [T2, T3],
      Review: [{ ...T1, attention: true }],
    }),
    proposal: null,
    changed: [T1.id, T2.id, T3.id],
  },
  {
    action: "Apply changes",
    caption: "Aril proposes a task. Nothing changes until you select Apply changes.",
    queueOn: true,
    columns: board({
      Backlog: [T4],
      "In progress": [T2, T3],
      Review: [{ ...T1, attention: true }],
    }),
    proposal: { operation: "Create task", text: PROPOSAL_TEXT, applied: false },
    changed: [],
  },
  {
    action: "Start over",
    caption: "Apply changes adds T-5 to Backlog. Only you mark T-1 done.",
    queueOn: true,
    columns: board({
      Backlog: [T4, T5],
      "In progress": [T2, T3],
      Review: [{ ...T1, attention: true }],
    }),
    proposal: { operation: "Create task", text: PROPOSAL_TEXT, applied: true },
    changed: [T5.id],
  },
];
