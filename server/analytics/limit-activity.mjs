const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
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

function windowDurationMs(value) {
  const text = boundedText(value, 40)?.toLowerCase().replace(/\s+/g, " ");
  if (text === "5 hours" || text === "5 hour" || text === "5h") return FIVE_HOURS_MS;
  if (text === "7 days" || text === "7 day" || text === "7d") return SEVEN_DAYS_MS;
  return null;
}

function normalizedModel(value) {
  return boundedText(value, 120)?.toLowerCase().replace(/[\s_.:]+/g, "-") || null;
}

function textMatchesSegments(value, segments) {
  const text = normalizedModel(value);
  return Boolean(text && segments.some((segment) => text.includes(segment)));
}

function policyFor(policiesByProvider, provider) {
  if (policiesByProvider instanceof Map) return policiesByProvider.get(provider)?.usageLimitActivity || null;
  return policiesByProvider?.[provider]?.usageLimitActivity || null;
}

function modelMatchesLimit(limit, model) {
  return limit.scope === "model" && textMatchesSegments(model, limit.modelSegments || []);
}

function normalizedProviderLimits(item, policy = null) {
  if (!item || typeof item !== "object") return null;
  const provider = boundedText(item.provider, 80);
  const source = boundedText(item.source, 120);
  const usageLimits = item.usageLimits;
  if (!provider || !source || !usageLimits || typeof usageLimits !== "object") return null;
  const observedAt = timestamp(usageLimits.fetchedAt);
  if (!observedAt || !Array.isArray(usageLimits.limits)) return null;

  const candidates = usageLimits.limits.filter((limit) => limit && typeof limit === "object"
    && windowDurationMs(limit.window) !== null);
  const trackedLimitIds = policy?.trackedLimitIds;
  const eligible = Array.isArray(trackedLimitIds)
    ? trackedLimitIds.flatMap((id) => candidates.find((limit) => boundedText(limit.id, 120) === id) || [])
    : candidates;
  return eligible.flatMap((selected) => {
    const limitId = boundedText(selected.id, 120) || "current-session";
    const label = boundedText(selected.label, 160) || "Current session";
    const window = boundedText(selected.window, 40) || "5 hours";
    const durationMs = windowDurationMs(window);
    const percent = finitePercent(selected.percent);
    if (percent === null || durationMs === null) return [];
    const resetsAt = selected.resetsAt === null || selected.resetsAt === undefined
      ? null
      : timestamp(selected.resetsAt);
    if (selected.resetsAt !== null && selected.resetsAt !== undefined && !resetsAt) return [];
    const modelScope = policy?.modelScopes?.find((entry) => entry.limitId === limitId);
    const scope = modelScope ? "model" : "account";
    return [{
      provider,
      source,
      limitId,
      label,
      window,
      scope,
      modelSegments: modelScope?.modelSegments || [],
      durationMs,
      percent,
      resetsAt,
      observedAt,
    }];
  });
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
  const requestModelObservations = (Array.isArray(session.requestModelObservations) ? session.requestModelObservations : []).flatMap((observation) => {
    if (!observation || typeof observation !== "object") return [];
    const id = boundedText(observation.id, 180);
    const observedAt = timestamp(observation.observedAt);
    const model = boundedText(observation.model, 120);
    return observedAt && model ? [{ ...(id ? { id } : {}), observedAt, model }] : [];
  });
  return {
    id,
    provider,
    source,
    createdAt: timestamp(session.createdAt),
    title: boundedText(session.title, 240) || "Untitled session",
    project: boundedText(session.project, 240) || "",
    isLive: session.isLive === true,
    requestObservations,
    requestModelObservations,
    usageLimitRejections,
  };
}

function normalizeMaximum(value, fallback) {
  return Number.isInteger(value) ? Math.max(0, value) : fallback;
}

function recentBoundaryAtOrBefore(value, observedAt, durationMs) {
  const boundary = timestamp(value);
  const boundaryMs = Date.parse(boundary || "");
  const observedMs = Date.parse(observedAt || "");
  return Number.isFinite(boundaryMs)
    && Number.isFinite(observedMs)
    && boundaryMs <= observedMs
    && boundaryMs >= observedMs - durationMs
    ? boundary
    : null;
}

function windowStartFromReset(value, observedAt, durationMs) {
  const reset = timestamp(value);
  if (!reset) return null;
  return recentBoundaryAtOrBefore(new Date(Date.parse(reset) - durationMs).toISOString(), observedAt, durationMs);
}

function windowStartFromRejection(event, generatedAt, durationMs) {
  const observedAt = timestamp(event?.observedAt);
  const resetsAt = timestamp(event?.resetsAt);
  const observedMs = Date.parse(observedAt || "");
  const resetMs = Date.parse(resetsAt || "");
  const generatedMs = Date.parse(generatedAt || "");
  if (!Number.isFinite(observedMs) || !Number.isFinite(resetMs) || !Number.isFinite(generatedMs)) return null;
  if (durationMs !== FIVE_HOURS_MS || observedMs > generatedMs || observedMs > resetMs || observedMs < resetMs - durationMs) return null;
  const candidate = resetMs < generatedMs ? resetsAt : new Date(resetMs - durationMs).toISOString();
  return recentBoundaryAtOrBefore(candidate, generatedAt, durationMs);
}

function limitKey(limit) {
  return `${limit.provider}\u0000${limit.limitId}\u0000${limit.durationMs}`;
}

function dominantProviderModel(sessions, provider, generatedAt) {
  const endMs = Date.parse(generatedAt);
  const startMs = endMs - SEVEN_DAYS_MS;
  const counts = new Map();
  for (const session of sessions) {
    if (session.provider !== provider) continue;
    for (const observation of session.requestModelObservations) {
      const at = Date.parse(observation.observedAt);
      if (!Number.isFinite(at) || at < startMs || at > endMs) continue;
      const model = observation.model.toLowerCase().replace(/[\s_]+/g, "-");
      counts.set(model, (counts.get(model) || 0) + 1);
    }
  }
  const ordered = [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  if (!ordered.length || (ordered[1] && ordered[0][1] === ordered[1][1])) return null;
  return ordered[0][0];
}

function selectedProviderLimits(providerLimits, sessions, generatedAt, policiesByProvider) {
  const normalized = providerLimits.flatMap((item) => normalizedProviderLimits(
    item,
    policyFor(policiesByProvider, item?.provider),
  ) || []);
  const selected = [];
  for (const provider of new Set(normalized.map((limit) => limit.provider))) {
    const candidates = normalized.filter((limit) => limit.provider === provider);
    const selection = policyFor(policiesByProvider, provider)?.selection || { mode: "all" };
    if (selection.mode === "all") {
      selected.push(...candidates);
      continue;
    }
    const dominantModel = dominantProviderModel(sessions, provider, generatedAt);
    const override = selection.overrides.find((entry) => entry.models.includes(dominantModel));
    const selectedWindow = override?.window || selection.defaultWindow;
    const durationMs = selectedWindow === "5h" ? FIVE_HOURS_MS : SEVEN_DAYS_MS;
    const preferredSegments = override?.preferredLimitSegments || [];
    const excludedSegments = override ? [] : selection.defaultExcludedLimitSegments;
    const selectedLimit = candidates.find((limit) => limit.durationMs === durationMs
      && preferredSegments.length > 0
      && textMatchesSegments(`${limit.limitId}-${limit.label}`, preferredSegments))
      || candidates.find((limit) => limit.durationMs === durationMs
        && !textMatchesSegments(`${limit.limitId}-${limit.label}`, excludedSegments))
      || candidates.find((limit) => limit.durationMs === durationMs);
    if (selectedLimit) selected.push(selectedLimit);
  }
  return selected;
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

  function observe(providerLimits, policiesByProvider = {}) {
    if (!Array.isArray(providerLimits)) return;
    for (const item of providerLimits) {
      for (const current of normalizedProviderLimits(item, policyFor(policiesByProvider, item?.provider)) || []) {
        const key = limitKey(current);
        const previous = histories.get(key);
        const samples = previous?.samples ? [...previous.samples] : [];
        const last = samples[samples.length - 1];
        if (last && Date.parse(current.observedAt) < Date.parse(last.observedAt)) continue;
        const previousStart = recentBoundaryAtOrBefore(previous?.windowStartsAt, current.observedAt, current.durationMs);
        const currentResetStart = windowStartFromReset(current.resetsAt, current.observedAt, current.durationMs);
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
            ? recentBoundaryAtOrBefore(last?.resetsAt, current.observedAt, current.durationMs)
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
          scope: current.scope,
          modelSegments: current.modelSegments,
          durationMs: current.durationMs,
          windowStartsAt,
          windowStartsAtExact,
          samples: observationLimit > 0 ? nextSamples.slice(-observationLimit) : [],
        });
        trimHistories();
      }
    }
  }

  function build({ providerLimits = [], sessions = [], modelSelectionSessions = sessions, policiesByProvider = {}, generatedAt } = {}) {
    observe(providerLimits, policiesByProvider);
    const generated = timestamp(generatedAt) || new Date().toISOString();
    const safeSessions = Array.isArray(sessions) ? sessions.map(safeSession).filter(Boolean) : [];
    const safeModelSelectionSessions = Array.isArray(modelSelectionSessions)
      ? modelSelectionSessions.map(safeSession).filter(Boolean)
      : safeSessions;
    const activities = [];
    const seen = new Set();
    for (const current of selectedProviderLimits(
      Array.isArray(providerLimits) ? providerLimits : [],
      safeModelSelectionSessions,
      generated,
      policiesByProvider,
    )) {
      const key = limitKey(current);
      if (seen.has(key)) continue;
      seen.add(key);
      const history = histories.get(key);
      if (!history || !history.samples.length) continue;
      const samples = history.samples;
      const latestSample = samples.at(-1);
      const fallbackStartMs = Date.parse(generated) - history.durationMs;
      const rawProviderSessions = safeSessions
        .filter((session) => session.provider === history.provider && session.source === history.source);
      const recordedWindowStart = rawProviderSessions
        .flatMap((session) => session.usageLimitRejections)
        .map((event) => windowStartFromRejection(event, generated, history.durationMs))
        .filter(Boolean)
        .sort((left, right) => Date.parse(left) - Date.parse(right))
        .at(-1) || null;
      const resetDerivedStart = windowStartFromReset(latestSample.resetsAt, generated, history.durationMs);
      const trackedStart = recentBoundaryAtOrBefore(history.windowStartsAt, generated, history.durationMs);
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
        ? new Date(startMs + history.durationMs).toISOString()
        : null;
      const providerSessions = rawProviderSessions
        .map((session) => {
          const scopedModels = session.requestModelObservations.filter((observation) => modelMatchesLimit(history, observation.model));
          const scopedRequestIds = new Set(scopedModels.flatMap((observation) => observation.id ? [observation.id] : []));
          return {
            ...session,
            requestObservations: session.requestObservations.filter((request) => {
              const at = Date.parse(request.observedAt);
              const inScope = history.scope !== "model"
                || scopedRequestIds.has(request.id);
              return at >= startMs && at <= endMs && inScope;
            }),
            usageLimitRejections: session.usageLimitRejections.filter((event) => {
              const at = Date.parse(event.observedAt);
              return at >= startMs && at <= endMs
                && expectedResetAt !== null
                && event.resetsAt === expectedResetAt;
            }),
          };
        });
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
        scope: history.scope,
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

    const requestLanes = activities.flatMap((activity) => activity.sessions.flatMap((session) => {
      const requests = [...session.requestObservations]
        .sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt) || left.id.localeCompare(right.id));
      return requests.length ? [{ activity, session, requests }] : [];
    })).sort((left, right) => Date.parse(right.requests[0].observedAt) - Date.parse(left.requests[0].observedAt)
      || left.activity.provider.localeCompare(right.activity.provider)
      || left.session.id.localeCompare(right.session.id));
    const retainedRequests = new Set();
    for (let requestIndex = 0; retainedRequests.size < publicEventLimit; requestIndex += 1) {
      let added = false;
      for (const { activity, session, requests } of requestLanes) {
        const request = requests[requestIndex];
        if (!request || retainedRequests.size >= publicEventLimit) continue;
        retainedRequests.add(`${activity.provider}\u0000${activity.limitId}\u0000${session.id}\u0000${request.id}`);
        added = true;
      }
      if (!added) break;
    }
    for (const activity of activities) {
      const requestCount = activity.sessions.reduce((total, session) => total + session.requestObservations.length, 0);
      for (const session of activity.sessions) {
        session.requestObservations = session.requestObservations.filter((request) => retainedRequests.has(`${activity.provider}\u0000${activity.limitId}\u0000${session.id}\u0000${request.id}`));
      }
      activity.sessions = activity.sessions.filter((session) => session.requestObservations.length > 0);
      const retainedSessionIds = new Set(activity.sessions.map((session) => session.id));
      activity.movements = activity.movements.map((movement) => {
        const sessionIds = movement.sessionIds.filter((sessionId) => retainedSessionIds.has(sessionId));
        return {
          ...movement,
          correlation: sessionIds.length === 1 ? "single" : sessionIds.length > 1 ? "shared" : "unobserved",
          sessionIds,
        };
      });
      const retainedCount = activity.sessions.reduce((total, session) => total + session.requestObservations.length, 0);
      if (retainedCount < requestCount) activity.eventsTruncated = true;
    }
    return activities;
  }

  return { observe, build };
}
