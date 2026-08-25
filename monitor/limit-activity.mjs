const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const DEFAULT_MAX_OBSERVATIONS = 64;
const DEFAULT_MAX_PUBLIC_EVENTS = 240;
const DEFAULT_MAX_HISTORIES = 16;
const MAX_TEXT = 240;

function boundedText(value, maximum = MAX_TEXT) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text.slice(0, maximum) : null;
}

function timestamp(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function finitePercent(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) return null;
  return value;
}

function fiveHourWindow(value) {
  const text = boundedText(value, 40)?.toLowerCase().replace(/\s+/g, " ");
  return text === "5 hours" || text === "5 hour" || text === "5h";
}

function normalizedProviderLimit(item) {
  if (!item || typeof item !== "object") return null;
  const provider = boundedText(item.provider, 80);
  const source = boundedText(item.source, 120);
  const usageLimits = item.usageLimits;
  if (!provider || !source || !usageLimits || typeof usageLimits !== "object") return null;
  const observedAt = timestamp(usageLimits.fetchedAt);
  if (!observedAt || !Array.isArray(usageLimits.limits)) return null;

  const candidates = usageLimits.limits.filter((limit) => limit && typeof limit === "object");
  const preferred = candidates.find((limit) => boundedText(limit.id, 120) === "current-session" && fiveHourWindow(limit.window));
  const selected = preferred || candidates.find((limit) => fiveHourWindow(limit.window));
  if (!selected) return null;

  const limitId = boundedText(selected.id, 120) || "current-session";
  const label = boundedText(selected.label, 160) || "Current session";
  const window = boundedText(selected.window, 40) || "5 hours";
  const percent = finitePercent(selected.percent);
  if (percent === null || !fiveHourWindow(window)) return null;
  const resetsAt = selected.resetsAt === null || selected.resetsAt === undefined
    ? null
    : timestamp(selected.resetsAt);
  if (selected.resetsAt !== null && selected.resetsAt !== undefined && !resetsAt) return null;
  return { provider, source, limitId, label, window, percent, resetsAt, observedAt };
}

function safeSession(session) {
  if (!session || typeof session !== "object") return null;
  const id = boundedText(session.id, 180);
  const provider = boundedText(session.provider, 80);
  const source = boundedText(session.source, 120);
  if (!id || !provider || !source || !Array.isArray(session.requestObservations)) return null;
  const requestObservations = session.requestObservations.flatMap((observation) => {
    if (!observation || typeof observation !== "object") return [];
    const observationId = boundedText(observation.id, 180);
    const observedAt = timestamp(observation.observedAt);
    return observationId && observedAt ? [{ id: observationId, observedAt }] : [];
  }).sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt) || left.id.localeCompare(right.id));
  const usageLimitRejections = (Array.isArray(session.usageLimitRejections) ? session.usageLimitRejections : []).flatMap((event) => {
    if (!event || typeof event !== "object") return [];
    const observedAt = timestamp(event.observedAt);
    const resetsAt = timestamp(event.resetsAt);
    return observedAt && resetsAt ? [{ observedAt, resetsAt }] : [];
  }).sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
  return {
    id,
    provider,
    source,
    createdAt: timestamp(session.createdAt),
    title: boundedText(session.title, 240) || "Untitled session",
    project: boundedText(session.project, 240) || "",
    isLive: session.isLive === true,
    requestObservations,
    usageLimitRejections,
  };
}

function normalizeMaximum(value, fallback) {
  return Number.isInteger(value) ? Math.max(0, value) : fallback;
}

function recentBoundaryAtOrBefore(value, observedAt) {
  const boundary = timestamp(value);
  const boundaryMs = Date.parse(boundary || "");
  const observedMs = Date.parse(observedAt || "");
  return Number.isFinite(boundaryMs)
    && Number.isFinite(observedMs)
    && boundaryMs <= observedMs
    && boundaryMs >= observedMs - FIVE_HOURS_MS
    ? boundary
    : null;
}

function windowStartFromReset(value, observedAt) {
  const reset = timestamp(value);
  if (!reset) return null;
  return recentBoundaryAtOrBefore(new Date(Date.parse(reset) - FIVE_HOURS_MS).toISOString(), observedAt);
}

function windowStartFromRejection(event, generatedAt) {
  const observedAt = timestamp(event?.observedAt);
  const resetsAt = timestamp(event?.resetsAt);
  const observedMs = Date.parse(observedAt || "");
  const resetMs = Date.parse(resetsAt || "");
  const generatedMs = Date.parse(generatedAt || "");
  if (!Number.isFinite(observedMs) || !Number.isFinite(resetMs) || !Number.isFinite(generatedMs)) return null;
  if (observedMs > generatedMs || observedMs > resetMs || observedMs < resetMs - FIVE_HOURS_MS) return null;
  const candidate = resetMs < generatedMs ? resetsAt : new Date(resetMs - FIVE_HOURS_MS).toISOString();
  return recentBoundaryAtOrBefore(candidate, generatedAt);
}

export function createHomeLimitActivityTracker({
  maxObservations = DEFAULT_MAX_OBSERVATIONS,
  maxPublicEvents = DEFAULT_MAX_PUBLIC_EVENTS,
  maxHistories = DEFAULT_MAX_HISTORIES,
} = {}) {
  const observationLimit = normalizeMaximum(maxObservations, DEFAULT_MAX_OBSERVATIONS);
  const publicEventLimit = normalizeMaximum(maxPublicEvents, DEFAULT_MAX_PUBLIC_EVENTS);
  const historyLimit = normalizeMaximum(maxHistories, DEFAULT_MAX_HISTORIES);
  const histories = new Map();

  function trimHistories() {
    while (histories.size > historyLimit) {
      let oldestKey = null;
      let oldestObservedAt = Number.POSITIVE_INFINITY;
      for (const [key, history] of histories) {
        const observedAt = Date.parse(history.samples.at(-1)?.observedAt || "");
        if (Number.isFinite(observedAt) && observedAt < oldestObservedAt) {
          oldestKey = key;
          oldestObservedAt = observedAt;
        }
      }
      histories.delete(oldestKey ?? histories.keys().next().value);
    }
  }

  function observe(providerLimits) {
    if (!Array.isArray(providerLimits)) return;
    for (const item of providerLimits) {
      const current = normalizedProviderLimit(item);
      if (!current) continue;
      const key = `${current.provider}\u0000${current.limitId}`;
      const previous = histories.get(key);
      const samples = previous?.samples ? [...previous.samples] : [];
      const last = samples[samples.length - 1];
      if (last && Date.parse(current.observedAt) < Date.parse(last.observedAt)) continue;
      const previousStart = recentBoundaryAtOrBefore(previous?.windowStartsAt, current.observedAt);
      const currentResetStart = windowStartFromReset(current.resetsAt, current.observedAt);
      const resetChanged = Boolean(previousStart && currentResetStart && previousStart !== currentResetStart);
      const percentageDropped = last && current.percent < last.percent;
      const alreadySeen = samples.some((sample) => sample.observedAt === current.observedAt);
      const nextSamples = (resetChanged || percentageDropped) ? [] : samples;
      if (!alreadySeen || resetChanged || percentageDropped) nextSamples.push({
        observedAt: current.observedAt,
        percent: current.percent,
        resetsAt: current.resetsAt,
      });
      nextSamples.sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
      let windowStartsAt = previous?.windowStartsAt || null;
      let windowStartsAtExact = previous?.windowStartsAtExact === true;
      if (!previous || resetChanged || percentageDropped) {
        const priorResetBoundary = percentageDropped
          ? recentBoundaryAtOrBefore(last?.resetsAt, current.observedAt)
          : null;
        windowStartsAt = percentageDropped
          ? priorResetBoundary || currentResetStart || previousStart
          : currentResetStart || previousStart;
        windowStartsAtExact = Boolean(windowStartsAt);
      } else if (currentResetStart) {
        windowStartsAt = currentResetStart;
        windowStartsAtExact = true;
      }
      histories.set(key, {
        provider: current.provider,
        source: current.source,
        limitId: current.limitId,
        label: current.label,
        window: current.window,
        windowStartsAt,
        windowStartsAtExact,
        samples: observationLimit > 0 ? nextSamples.slice(-observationLimit) : [],
      });
      trimHistories();
    }
  }

  function build({ providerLimits = [], sessions = [], generatedAt } = {}) {
    observe(providerLimits);
    const generated = timestamp(generatedAt) || new Date().toISOString();
    const safeSessions = Array.isArray(sessions) ? sessions.map(safeSession).filter(Boolean) : [];
    const activities = [];
    const seen = new Set();
    for (const item of Array.isArray(providerLimits) ? providerLimits : []) {
      const current = normalizedProviderLimit(item);
      if (!current) continue;
      const key = `${current.provider}\u0000${current.limitId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const history = histories.get(key);
      if (!history || !history.samples.length) continue;
      const samples = history.samples;
      const latestSample = samples.at(-1);
      const fallbackStartMs = Date.parse(generated) - FIVE_HOURS_MS;
      const rawProviderSessions = safeSessions
        .filter((session) => session.provider === history.provider && session.source === history.source);
      const recordedWindowStart = rawProviderSessions
        .flatMap((session) => session.usageLimitRejections)
        .map((event) => windowStartFromRejection(event, generated))
        .filter(Boolean)
        .sort((left, right) => Date.parse(left) - Date.parse(right))
        .at(-1) || null;
      const resetDerivedStart = windowStartFromReset(latestSample.resetsAt, generated);
      const trackedStart = recentBoundaryAtOrBefore(history.windowStartsAt, generated);
      const exactStarts = (resetDerivedStart
        ? [resetDerivedStart]
        : [trackedStart, recordedWindowStart])
        .filter(Boolean)
        .sort((left, right) => Date.parse(left) - Date.parse(right));
      const windowStartsAt = exactStarts.at(-1) || new Date(fallbackStartMs).toISOString();
      const windowStartsAtExact = exactStarts.length > 0;
      const startMs = Date.parse(windowStartsAt);
      const endMs = Date.parse(generated);
      const expectedResetAt = windowStartsAtExact
        ? new Date(startMs + FIVE_HOURS_MS).toISOString()
        : null;
      const providerSessions = rawProviderSessions
        .map((session) => ({
          ...session,
          requestObservations: session.requestObservations.filter((request) => {
            const at = Date.parse(request.observedAt);
            return at >= startMs && at <= endMs;
          }),
          usageLimitRejections: session.usageLimitRejections.filter((event) => {
            const at = Date.parse(event.observedAt);
            return at >= startMs && at <= endMs
              && expectedResetAt !== null
              && event.resetsAt === expectedResetAt;
          }),
        }));
      const matchingSessions = providerSessions
        .filter((session) => session.requestObservations.length > 0)
        .sort((left, right) => {
          const leftCreated = Date.parse(left.createdAt || "");
          const rightCreated = Date.parse(right.createdAt || "");
          if (Number.isFinite(leftCreated) && Number.isFinite(rightCreated) && leftCreated !== rightCreated) {
            return leftCreated - rightCreated;
          }
          if (Number.isFinite(leftCreated) !== Number.isFinite(rightCreated)) return Number.isFinite(leftCreated) ? -1 : 1;
          return left.id.localeCompare(right.id);
        });
      const firstRejectedAt = providerSessions
        .flatMap((session) => session.usageLimitRejections.map((event) => event.observedAt))
        .sort((left, right) => Date.parse(left) - Date.parse(right))[0] || null;
      const windowSamples = samples.filter((sample) => {
        const at = Date.parse(sample.observedAt);
        return at >= startMs && at <= endMs;
      });
      const movements = [];
      for (let index = 1; index < windowSamples.length; index += 1) {
        const fromSample = windowSamples[index - 1];
        const toSample = windowSamples[index];
        const fromMs = Date.parse(fromSample.observedAt);
        const toMs = Date.parse(toSample.observedAt);
        if (toMs <= fromMs || toSample.percent <= fromSample.percent) continue;
        const sessionIds = matchingSessions.flatMap((session) => session.requestObservations.some((request) => {
          const at = Date.parse(request.observedAt);
          return at > fromMs && at <= toMs;
        }) ? [session.id] : []);
        const correlation = sessionIds.length === 1 ? "single" : sessionIds.length > 1 ? "shared" : "unobserved";
        movements.push({
          id: `${history.limitId}-${fromSample.observedAt}-${toSample.observedAt}`,
          from: fromSample.observedAt,
          to: toSample.observedAt,
          changePoints: toSample.percent - fromSample.percent,
          correlation,
          sessionIds,
        });
      }
      activities.push({
        provider: history.provider,
        source: history.source,
        limitId: history.limitId,
        label: history.label,
        window: history.window,
        percent: latestSample.percent,
        resetsAt: latestSample.resetsAt,
        windowStartsAt,
        windowStartsAtExact,
        generatedAt: generated,
        observedFrom: windowSamples[0]?.observedAt || latestSample.observedAt,
        firstRejectedAt,
        observations: windowSamples.map(({ observedAt, percent }) => ({ observedAt, percent })),
        status: windowSamples.length >= 2 ? "ready" : "collecting",
        partialCoverage: Date.parse(windowSamples[0]?.observedAt || latestSample.observedAt) > startMs,
        eventsTruncated: false,
        sessions: matchingSessions.map(({ id, title, project, isLive, requestObservations }) => ({ id, title, project, isLive, requestObservations })),
        movements,
      });
    }

    const allRequests = [];
    for (const activity of activities) {
      for (const session of activity.sessions) {
        for (const request of session.requestObservations) allRequests.push({ activity, session, request });
      }
    }
    allRequests.sort((left, right) => Date.parse(right.request.observedAt) - Date.parse(left.request.observedAt) || left.request.id.localeCompare(right.request.id));
    const retainedRequests = new Set(allRequests.slice(0, publicEventLimit).map(({ activity, session, request }) => `${activity.provider}\u0000${activity.limitId}\u0000${session.id}\u0000${request.id}`));
    for (const activity of activities) {
      const requestCount = activity.sessions.reduce((total, session) => total + session.requestObservations.length, 0);
      for (const session of activity.sessions) {
        session.requestObservations = session.requestObservations.filter((request) => retainedRequests.has(`${activity.provider}\u0000${activity.limitId}\u0000${session.id}\u0000${request.id}`));
      }
      const retainedCount = activity.sessions.reduce((total, session) => total + session.requestObservations.length, 0);
      if (retainedCount < requestCount) activity.eventsTruncated = true;
    }
    return activities;
  }

  return { observe, build };
}
