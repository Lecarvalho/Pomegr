import { createRoot } from "react-dom/client";
import { useActivityHistory } from "../app/components/dashboard/useActivityHistory";

/** A deliberately small real-renderer surface for the opt-in Electron smoke. */
function ActivityHistoryHarness() {
  const history = useActivityHistory({
    enabled: true,
    sessionId: "claude:fixture",
    scope: "all",
    filterRequestId: null,
    navigation: null,
  });

  return <main>
    <ul>
      {history.page?.items.map((item) => <li
        id={`row-${item.id}`}
        key={item.id}
        data-link={item.requestId ? "linked" : "unlinked"}
        data-duration={item.durationMs === null ? "" : String(item.durationMs)}
      >
        {item.id}
      </li>)}
    </ul>
  </main>;
}

const root = document.getElementById("root");
if (!root) throw new Error("renderer smoke root is unavailable");
createRoot(root).render(<ActivityHistoryHarness />);
