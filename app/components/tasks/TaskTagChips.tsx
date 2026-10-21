/** The tags of a task's first line as one wrapping row of the shared neutral chip. Display only: the task text keeps its brackets. */
export function TaskTagChips({ tags }: { tags: readonly string[] }) {
  if (tags.length === 0) return null;
  return <div className="taskTags" role="group" aria-label="Tags">
    {tags.map((tag) => <span key={tag} className="commandChip taskTag">{tag}</span>)}
  </div>;
}
