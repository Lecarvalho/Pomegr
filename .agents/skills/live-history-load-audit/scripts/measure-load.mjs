const DEFAULT_BASE = "http://127.0.0.1:3003";
const DEFAULT_SAMPLES = 5;
const DEFAULT_HISTORY_CONCURRENCY = 6;
const REQUEST_TIMEOUT_MS = 10_000;

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function loopbackOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("The load smoke target must be a loopback HTTP origin");
  }
  return url.origin;
}

async function timed(url) {
  const startedAt = performance.now();
  const response = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await response.arrayBuffer();
  return {
    ms: Number((performance.now() - startedAt).toFixed(1)),
    status: response.status,
    bytes: body.byteLength,
  };
}

function summary(samples) {
  const durations = samples.map(({ ms }) => ms).sort((left, right) => left - right);
  return {
    medianMs: durations[Math.floor(durations.length / 2)],
    minMs: durations[0],
    maxMs: durations.at(-1),
    statuses: [...new Set(samples.map(({ status }) => status))],
    bytes: [...new Set(samples.map(({ bytes }) => bytes))],
  };
}

const base = loopbackOrigin(argument("--base", DEFAULT_BASE));
const samples = boundedInteger(argument("--samples", DEFAULT_SAMPLES), DEFAULT_SAMPLES, 3, 20);
const historyConcurrency = boundedInteger(
  argument("--history-concurrency", DEFAULT_HISTORY_CONCURRENCY),
  DEFAULT_HISTORY_CONCURRENCY,
  1,
  12,
);

const catalogResponse = await fetch(`${base}/api/sessions`, {
  cache: "no-store",
  signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
});
if (!catalogResponse.ok) throw new Error(`Session catalog returned HTTP ${catalogResponse.status}`);
const catalog = await catalogResponse.json();
const selected = catalog.sessions?.find((entry) => entry?.isLive) || catalog.sessions?.[0];
if (!selected?.id) throw new Error("No session is available for the load smoke measurement");

const sessionId = encodeURIComponent(selected.id);
const urls = {
  state: `${base}/api/state?sessionId=${sessionId}`,
  activity: `${base}/api/session-history?sessionId=${sessionId}&kind=activity&limit=8&offset=latest`,
  requests: `${base}/api/session-history?sessionId=${sessionId}&kind=requests&scope=all&limit=60&offset=latest`,
};

const cold = {
  state: await timed(urls.state),
  activity: await timed(urls.activity),
  requests: await timed(urls.requests),
};
const warm = { state: [], activity: [], requests: [] };
for (let index = 0; index < samples; index += 1) {
  warm.state.push(await timed(urls.state));
  warm.activity.push(await timed(urls.activity));
  warm.requests.push(await timed(urls.requests));
}

const stateDuringHistory = [];
for (let index = 0; index < samples; index += 1) {
  const historyReads = Array.from({ length: historyConcurrency }, (_, historyIndex) => (
    timed(historyIndex % 2 === 0 ? urls.activity : urls.requests)
  ));
  stateDuringHistory.push(await timed(urls.state));
  await Promise.all(historyReads);
}

console.log(JSON.stringify({
  target: "loopback",
  selectedSessionIsLive: Boolean(selected.isLive),
  samples,
  historyConcurrency,
  cold,
  warm: {
    state: summary(warm.state),
    activity: summary(warm.activity),
    requests: summary(warm.requests),
  },
  stateDuringConcurrentHistory: summary(stateDuringHistory),
}, null, 2));
