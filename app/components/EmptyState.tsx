export function EmptyState({ text }: { text: string }) {
  return <div className="empty"><span>·</span>{text}</div>;
}
