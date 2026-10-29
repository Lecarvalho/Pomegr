// The board an agent route reads or writes for a session: the board of the task the session is linked to, else the
// board of the session's committed repository when that repository is confirmed (T-200). Store reads only.
const REPOSITORY_ID_PATTERN = /^repo-[a-f0-9]{24}$/u;

function linkedBoardRepositoryId(taskStore, sessionRef) {
  try {
    const repositoryId = typeof taskStore?.sessionTasks === "function" ? taskStore.sessionTasks([sessionRef])?.get(sessionRef)?.repositoryId : null;
    return typeof repositoryId === "string" && REPOSITORY_ID_PATTERN.test(repositoryId) ? repositoryId : null;
  } catch {
    return null;
  }
}

export function agentBoardRepository(taskStore, resolveSession, sessionRef) {
  const linkedRepositoryId = linkedBoardRepositoryId(taskStore, sessionRef);
  let session = null;
  try {
    session = resolveSession(sessionRef);
  } catch (error) {
    if (linkedRepositoryId === null) throw error;
  }
  if (linkedRepositoryId === null && (!session || session.found !== true)) return { reason: "session_not_found" };
  const repositoryId = linkedRepositoryId ?? session.repositoryId;
  if (typeof repositoryId !== "string" || !REPOSITORY_ID_PATTERN.test(repositoryId)) return { reason: "repository_unavailable" };
  if (linkedRepositoryId !== null) return { repositoryId };
  // An observed repository is a board only when Git confirmed it, or when it is not a guess and its board exists.
  // A guessed identity, such as a removed folder's, never reads or creates a board.
  const confirmation = session.repositoryConfirmation;
  if (confirmation === "confirmed") return { repositoryId };
  if (confirmation !== "guessed" && typeof taskStore.hasBoard === "function" && taskStore.hasBoard(repositoryId) === true) return { repositoryId };
  return { reason: "repository_unavailable" };
}
