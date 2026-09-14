import { subscribeLiveEvents } from "./live-events";

export type HistoryPublication = Readonly<{ domain: "history"; revision: number }>;
type Listener = (publication: HistoryPublication) => void;

export function subscribeHistoryPublications(listener: Listener): () => void {
  if (typeof listener !== "function") throw new TypeError("History publication listener must be a function");
  return subscribeLiveEvents((event) => {
    if (event.type !== "revision" || event.domain !== "history") return;
    // Legacy consumers only need the revision; session-aware hooks subscribe to
    // live-events directly so they can reject cross-session publications.
    listener(Object.freeze({ domain: "history", revision: event.revision }));
  });
}
