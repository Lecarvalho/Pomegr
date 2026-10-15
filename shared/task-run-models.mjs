// The selectable models of the Run on list, one source for the task forms and for Aril's board snapshot: Claude's newest
// observed model of each family, and the committed Codex client catalog.

/**
 * The agents query whose runs feed the Claude list: every project, the last 90 days, every agent scope.
 * @type {Readonly<{ project: string; days: 90; scope: "all" }>}
 */
export const RUN_MODEL_AGENTS_QUERY = Object.freeze({ project: "all", days: 90, scope: "all" });

const MODEL_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:+[\]-]*$/u;
const MODEL_IDENTIFIER_LENGTH = 120;

const isModelIdentifier = (value) => typeof value === "string" && value.length <= MODEL_IDENTIFIER_LENGTH && MODEL_IDENTIFIER.test(value);

function modelVersion(model) {
  const words = [];
  const version = [];
  let date = 0;
  for (const part of model.toLowerCase().split("-")) {
    if (/^\d{8}$/u.test(part)) date = Number(part);
    else if (/^\d+(?:\.\d+)*$/u.test(part)) version.push(...part.split(".").map(Number));
    else words.push(part);
  }
  return { family: words.join("-"), version, date };
}

function isNewerModel(candidate, current) {
  for (let index = 0; index < Math.max(candidate.version.length, current.version.length); index += 1) {
    const difference = (candidate.version[index] ?? 0) - (current.version[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return candidate.date > current.date;
}

/**
 * The newest model of each family, sorted.
 * @param {Iterable<string>} models
 * @returns {string[]}
 */
export function latestModels(models) {
  const newest = new Map();
  for (const model of models) {
    const parsed = modelVersion(model);
    const current = newest.get(parsed.family);
    if (!current || isNewerModel(parsed, current.parsed)) newest.set(parsed.family, { model, parsed });
  }
  return [...newest.values()].map((entry) => entry.model).sort();
}

/**
 * Run on models per provider.
 * @param {ReadonlyArray<{ source: string; model: string | null }>} runs
 * @param {ReadonlyArray<{ id: string }>} [codexCatalog]
 * @returns {{ claude: string[]; codex: string[] }}
 */
export function modelsByProvider(runs, codexCatalog = []) {
  const claude = new Set();
  for (const run of runs) {
    if (run?.source === "Claude Code" && isModelIdentifier(run.model)) claude.add(run.model);
  }
  const codex = codexCatalog.map((model) => model?.id).filter(isModelIdentifier);
  return { claude: latestModels(claude), codex: [...new Set(codex)] };
}
