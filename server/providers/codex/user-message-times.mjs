import { parseCodexUserInputRecords } from "./user-input.mjs";

const MAX_TIMES = 256;

// This map is acquisition-private. Only its timestamps enter normalized evidence.
export const createCodexUserMessageTimeState = () => new Map();

export function reduceCodexUserMessageTimes(state, record) {
  for (const input of parseCodexUserInputRecords([record])) {
    // Match the shared evidence contract's four-digit-year canonical UTC spelling.
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input.timestamp)) continue;
    state.set(input.id, input.timestamp);
  }
  if (state.size > MAX_TIMES) {
    const oldest = [...state].sort((a, b) => a[1].localeCompare(b[1]));
    for (const [id] of oldest.slice(0, state.size - MAX_TIMES)) state.delete(id);
  }
  return state;
}

export const codexUserMessageTimesFromState = (state) => [...state.values()].sort();

/** Complete-source reads use the same reducer as incremental observation; partial tails cannot assert message times. */
export function codexUserMessageTimes(records) {
  const state = createCodexUserMessageTimeState();
  for (const record of records) reduceCodexUserMessageTimes(state, record);
  return codexUserMessageTimesFromState(state);
}
