const PAGE_SIZE = 60;
const MAX_READS = 24;
const USER_MESSAGE_ROUTE = /^at:(\d{1,16})$/u;

export type ActivityRowsPage = { offset: number; total: number; items: unknown[] };
export type ReadActivityRows = (offset: number | "latest") => Promise<ActivityRowsPage | null>;

export function userMessageRoute(at: string): string | null {
  const time = Date.parse(at);
  return Number.isSafeInteger(time) && time >= 0 ? `at:${time}` : null;
}

export function userMessageRouteTime(request: string): number | null {
  const match = USER_MESSAGE_ROUTE.exec(request);
  return match ? Number(match[1]) : null;
}

function rowTime(row: unknown) {
  const timestamp = (row as { timestamp?: unknown } | null)?.timestamp;
  return typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
}

function linkedRequestNumber(row: unknown, time: number) {
  const { tool, requestNumber } = (row ?? {}) as { tool?: unknown; requestNumber?: unknown };
  return tool === "User input" && rowTime(row) === time && typeof requestNumber === "number" && Number.isSafeInteger(requestNumber) && requestNumber > 0
    ? requestNumber : null;
}

export async function locateUserInputRequest(time: number, read: ReadActivityRows): Promise<number | null | undefined> {
  let low = 0;
  let high: number | null = null;
  for (let reads = 0; reads < MAX_READS; reads += 1) {
    const page = await read(high === null ? "latest" : Math.max(low, Math.min(Math.floor((low + high) / 2), high - 1)));
    if (!page) return undefined;
    if (!page.items.length) return null;
    for (const row of page.items) {
      const number = linkedRequestNumber(row, time);
      if (number !== null) return number;
    }
    const first = rowTime(page.items[0]);
    const last = rowTime(page.items.at(-1));
    if (!Number.isFinite(first) || !Number.isFinite(last)) return null;
    // Rows sharing the boundary time may continue on the neighboring page.
    if (time <= first) high = page.offset;
    else if (time >= last) low = page.offset + page.items.length;
    else return null;
    if (high === null) high = page.total;
    if (low >= high) return null;
  }
  return null;
}

export { PAGE_SIZE as USER_INPUT_PAGE_SIZE };
