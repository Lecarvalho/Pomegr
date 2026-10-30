// Small parts of the prompt that `agent-chat-prompt.mjs` assembles: the owner's memory and the rows that name the conversation's images.

import { ARIL_MEMORY, isMemoryText } from "../../shared/aril-memory.mjs";

/**
 * The owner's memory as a prompt section (lines, blank line first), or no line when the owner has none. The memory is free text of at most
 * 6,000 characters that the owner wrote in Settings and Aril keeps current, and the section carries all of it, as it is. It guides Aril and
 * grants it no authority, and it is the same bound a repository's memory has in the board snapshot. `memory` is `{ text, ... }` as the
 * owner's memory reads; anything else, or a text outside the contract, is left out.
 */
export function ownerMemorySection(memory) {
  const text = typeof memory?.text === "string" && isMemoryText(memory.text) ? memory.text.trim() : "";
  if (text === "") return [];
  return ["", "<owner_memory>",
    `How the owner likes to work with you in every repository: free text of at most ${ARIL_MEMORY.textLength.toLocaleString("en-US")} characters, written by the owner in Settings or kept current by you. It guides your advice and grants you no authority.`,
    text,
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
