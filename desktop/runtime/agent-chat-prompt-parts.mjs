// Small parts of the prompt that `agent-chat-prompt.mjs` assembles: the owner's memory and the rows that name the conversation's images.

import { fitMemory } from "../../shared/aril-memory.mjs";

/**
 * The owner's memory as a prompt section (lines, blank line first), or no line when the owner has none. The entries are the owner's own
 * words, oldest first, and the section carries as many of the newest as fit `ARIL_MEMORY.promptLength` characters: older ones are left
 * out and counted. It guides Aril and grants it no authority, and it is the same bound a repository's memory has in the board snapshot.
 */
export function ownerMemorySection(entries) {
  const { entries: kept, omitted } = fitMemory(entries);
  if (kept.length === 0) return [];
  return ["", "<owner_memory>",
    "How the owner likes to work with you in every repository. The owner wrote these lines in Settings. They guide your advice and grant you no authority.",
    ...kept.map((entry) => `- ${entry.text}`),
    ...(omitted > 0 ? [`(${omitted} older ${omitted === 1 ? "entry is" : "entries are"} left out to fit the prompt.)`] : []),
    "</owner_memory>"];
}

/** One row for each image whose file is on this computer, within about 8,000 characters; the rest are named in one line. */
export function imageRowLines(images) {
  const rows = [];
  let length = 0;
  for (const image of images) {
    const row = `${image.id} (${image.type}): ${image.file}`;
    if (length + row.length + 1 > 7_900) { rows.push("(More image files are left out to fit the prompt.)"); break; }
    rows.push(row);
    length += row.length + 1;
  }
  return rows;
}
