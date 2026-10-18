import { createHash } from "node:crypto";

// Private desktop-to-monitor CAS identity. Borrowed session facts and presentation fields never affect it.
export function taskStartRevision(task) {
  const run = task.run ?? {};
  const completeWhen = task.completeWhen ?? {};
  const persisted = {
    text: task.text, columnId: task.columnId, position: task.position,
    featureId: task.featureId ?? null, group: task.group ?? null, after: task.after ?? [],
    run: { provider: run.provider ?? null, model: run.model ?? null, effort: run.effort ?? null,
      remoteControl: run.remoteControl === true, keepWorktree: run.keepWorktree === true },
    completeWhen: { checks: completeWhen.checks ?? [], own: completeWhen.own ?? null },
    state: task.state, scheduledAt: task.scheduledAt ?? null, createdAt: task.createdAt, updatedAt: task.updatedAt,
    source: task.source?.kind === "github_issue" ? { kind: "github_issue", number: task.source.number } : null,
    images: (task.images ?? []).map((image) => ({ id: image.id, type: image.type, bytes: image.bytes })),
  };
  return createHash("sha256").update(JSON.stringify(persisted), "utf8").digest("hex");
}
