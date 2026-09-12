import { cacheReadReuseDroppedModelChangeSignalDefinition, cacheReadReuseDroppedSignalDefinition, cacheRefillSignalDefinition } from "../../../../shared/signal-dictionary";
import { formatDuration } from "../../../dashboard-utils";
import { ExternalLink } from "../../ExternalLink";
import { CacheRefillIcon } from "../CacheRefillIcon";
import { summarizeCacheRefillOccurrences } from "../AgentHistoryIndicators";
import { cacheEvidenceLabel } from "./cache-evidence";
import type { RequestRow } from "./model";

export function RequestCacheDetail({ row }: { row: RequestRow }) {
  const evidence = row.cacheEvidence;
  if (!evidence) return null;
  const inferred = evidence.kind === "possible_refill";
  const modelChanged = evidence.kind === "model_change";
  const writeBacked = evidence.kind === "refill";
  const observation = evidence.event ?? evidence.readDrop;
  const currentRead = observation?.cacheReadPercent ?? (row.promptTokens > 0 ? Math.round(row.cacheReadTokens / row.promptTokens * 100) : null);
  const previousRead = observation?.previousCacheReadPercent;
  const occurrence = evidence.occurrence;
  const explanation = occurrence ? summarizeCacheRefillOccurrences([{
    agentId: row.agentId, count: 1, occurrences: [occurrence], reasons: [], toolChangeAttributions: [],
  }], [row.agentId])[0] : null;
  const definition = modelChanged ? cacheReadReuseDroppedModelChangeSignalDefinition() : inferred ? cacheReadReuseDroppedSignalDefinition() : occurrence ? cacheRefillSignalDefinition(occurrence) : null;
  return <section className="requestsActionsCacheDetail" aria-label="Request cache evidence">
    <h4><CacheRefillIcon inferred={!writeBacked} />{cacheEvidenceLabel(evidence)}</h4>
    <p className="requestsActionsCacheProvenance">{modelChanged ? "Observed cache-read drop · model change recorded" : inferred ? "Inference · no recorded cache write" : "Recorded cache-write evidence"}</p>
    <dl>
      {currentRead !== null && <div><dt>Cache read</dt><dd>{previousRead != null ? `${previousRead}% → ` : ""}{currentRead}%</dd></div>}
      {writeBacked && <div><dt>Cache write</dt><dd>{(evidence.event?.cacheWriteTokens ?? row.cacheWriteTokens).toLocaleString()} tokens</dd></div>}
      {observation?.gapMs != null && <div><dt>Request gap</dt><dd>{formatDuration(observation.gapMs)} wall time</dd></div>}
    </dl>
    {modelChanged ? <p>A model change was recorded between these requests. A refill and its cause cannot be confirmed.</p> : inferred ? <p>No positive cache-write evidence, so a refill and its cause cannot be confirmed.</p> : <>
      <p>Provider diagnostic: {explanation?.reason ?? "reason unavailable"}.</p>
      {explanation?.inference && <p>Inference: {explanation.inference}.</p>}
      {occurrence?.messageChangeSequence && definition && <p>{definition.observed}</p>}
    </>}
    {definition && <ExternalLink href={definition.href}>Open signal definition</ExternalLink>}
  </section>;
}
