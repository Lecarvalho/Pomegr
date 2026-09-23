// Provider-neutral, pure recognizer for file-writing shell commands. Given a
// whole shell command string as an agent issued it (POSIX "Bash" grammar or
// Windows "PowerShell" grammar), returns candidate {target, kind,
// previousTarget?} file changes for the small set of write shapes this
// module can unambiguously explain end to end.
//
// The command text itself never leaves this module: callers receive only
// the parsed targets, which then flow through the existing provider path
// pipeline (repository-relative normalization, `assertCheckpointPayload`,
// and the dedicated repository-path validator) unchanged. This module does
// no path validation of its own and must not weaken any downstream check.
//
// Fail-closed contract: anything this module cannot fully explain -- an
// unrecognized command, an unknown option, a pipe into an unrecognized
// writer, command substitution, variable expansion, globs, backticks,
// heredocs, `cd` anywhere in the command, or a stray/unterminated quote --
// rejects the WHOLE command (returns []) rather than guessing. A command
// that is entirely read-only (no recognized writer anywhere) also returns
// [] as a matter of course.

const MAX_CANDIDATES = 64;

// Characters that make a command unrecognizable no matter where they
// appear, including inside quotes: command substitution / variable
// expansion ($...), backticks (legacy substitution in POSIX, the escape /
// line-continuation character in PowerShell), glob characters, input
// redirection and heredocs (<, <<), and control characters other than the
// tab and space already treated as whitespace. Blanket-rejecting these even
// inside quotes trades a few falsely-rejected literal filenames (a path
// that legitimately contains "*") for a parser with no expansion semantics
// left to get wrong -- consistent with this module's fail-closed contract.
const ALWAYS_FORBIDDEN = /[`$*?[\]<\u0000-\u0008\u000a-\u001f\u007f]/u;

/**
 * Hand-rolled lexer for the narrow command grammar this module supports:
 * whitespace-separated words, single/double-quoted literals (no nested
 * expansion), and the operators &&, ;, |, >>, >. Returns null the moment it
 * meets anything outside that grammar so the caller can fail closed.
 */
function tokenize(command) {
  const tokens = [];
  const n = command.length;
  let i = 0;
  while (i < n) {
    const ch = command[i];
    if (ch === " " || ch === "\t") { i += 1; continue; }
    if (ALWAYS_FORBIDDEN.test(ch)) return null;
    if (command.startsWith("&&", i)) { tokens.push({ type: "op", value: "&&" }); i += 2; continue; }
    if (ch === "&") return null; // background jobs / fd duplication are unsupported
    if (ch === ";") { tokens.push({ type: "op", value: ";" }); i += 1; continue; }
    if (ch === "|") {
      if (command[i + 1] === "|") return null; // `||` conditional chaining is unsupported
      tokens.push({ type: "op", value: "|" }); i += 1; continue;
    }
    if (command.startsWith(">>", i)) { tokens.push({ type: "op", value: ">>" }); i += 2; continue; }
    if (ch === ">") { tokens.push({ type: "op", value: ">" }); i += 1; continue; }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      let value = "";
      while (j < n && command[j] !== quote) {
        if (command[j] === "\n" || command[j] === "\r") return null;
        value += command[j];
        j += 1;
      }
      if (j >= n) return null; // unterminated quote
      if (ALWAYS_FORBIDDEN.test(value)) return null;
      tokens.push({ type: "word", value });
      i = j + 1;
      continue;
    }
    let j = i;
    let value = "";
    while (j < n && !/\s/u.test(command[j]) && !"&;|<>\"'".includes(command[j])) {
      if (ALWAYS_FORBIDDEN.test(command[j])) return null;
      value += command[j];
      j += 1;
    }
    if (!value) return null; // a lone quote/operator character we didn't already handle
    tokens.push({ type: "word", value });
    i = j;
  }
  return tokens;
}

/** Split a token list on operator tokens matching `value`, dropping empty groups. */
function splitOn(tokens, value) {
  const groups = [[]];
  for (const token of tokens) {
    if (token.type === "op" && token.value === value) { groups.push([]); continue; }
    groups.at(-1).push(token);
  }
  return groups.filter((group) => group.length > 0);
}

function splitOnAny(tokens, values) {
  const groups = [[]];
  for (const token of tokens) {
    if (token.type === "op" && values.includes(token.value)) { groups.push([]); continue; }
    groups.at(-1).push(token);
  }
  return groups.filter((group) => group.length > 0);
}

function words(tokens) {
  return tokens.filter((token) => token.type === "word").map((token) => token.value);
}

// ---------------------------------------------------------------------------
// POSIX grammar
// ---------------------------------------------------------------------------

function posixMoveArgs(args) {
  if (args.length !== 2 || args.some((arg) => arg.startsWith("-"))) return null;
  return [{ target: args[1], kind: "moved", previousTarget: args[0] }];
}

function posixCp(args) {
  if (args.length !== 2 || args.some((arg) => arg.startsWith("-"))) return null;
  return [{ target: args[1], kind: "edited" }];
}

function posixTee(words_) {
  let rest = words_.slice(1);
  if (rest[0] === "-a") rest = rest.slice(1);
  if (!rest.length || rest.some((arg) => arg.startsWith("-"))) return null;
  return rest.map((target) => ({ target, kind: "edited" }));
}

// touch either creates a missing file or refreshes an existing one; like
// Write's own "unknown outcome" default, this module resolves that
// ambiguity to "edited" rather than guessing "created".
function posixTouch(args) {
  if (!args.length || args.some((arg) => arg.startsWith("-"))) return null;
  return args.map((target) => ({ target, kind: "edited" }));
}

function posixRm(args) {
  let rest = args;
  if (rest[0] === "-f") rest = rest.slice(1);
  if (!rest.length || rest.some((arg) => arg.startsWith("-"))) return null;
  return rest.map((target) => ({ target, kind: "deleted" }));
}

function posixGitRm(args) {
  if (!args.length || args.some((arg) => arg.startsWith("-"))) return null;
  return args.map((target) => ({ target, kind: "deleted" }));
}

// `sed -i[suffix] [-e expr | -E expr]... script target...`: an explicit -e
// (or -E) flag's value IS the script, so nothing further needs skipping;
// without one, the first non-flag token after -i is the opaque bare script
// and must itself be skipped before the in-place targets begin.
function posixSed(words_) {
  if (words_.length < 3 || !/^-i/u.test(words_[1])) return null;
  let index = 2;
  let sawScript = false;
  while (index < words_.length && words_[index].startsWith("-")) {
    if (words_[index] === "-e" || words_[index] === "-E") {
      if (words_[index + 1] === undefined) return null;
      sawScript = true;
      index += 2;
      continue;
    }
    return null; // unknown option
  }
  if (!sawScript) {
    if (index >= words_.length) return null; // no script
    index += 1; // skip the bare script token
  }
  const targets = words_.slice(index);
  if (!targets.length || targets.some((arg) => arg.startsWith("-"))) return null;
  return targets.map((target) => ({ target, kind: "edited" }));
}

function posixReadOnly(words_) {
  if (words_[0] === "echo" || words_[0] === "ls") return true;
  if (words_[0] === "git" && words_[1] === "status") return true;
  return false;
}

function posixCommand(words_) {
  const [head, ...rest] = words_;
  if (head === "tee") return posixTee(words_);
  if (head === "cp") return posixCp(rest);
  if (head === "mv") return posixMoveArgs(rest);
  if (head === "touch") return posixTouch(rest);
  if (head === "rm") return posixRm(rest);
  if (head === "sed") return posixSed(words_);
  if (head === "git" && rest[0] === "mv") return posixMoveArgs(rest.slice(1));
  if (head === "git" && rest[0] === "rm") return posixGitRm(rest.slice(1));
  if (head === "mkdir") return []; // directories are not files
  if (posixReadOnly(words_)) return [];
  return null;
}

// ---------------------------------------------------------------------------
// PowerShell grammar
// ---------------------------------------------------------------------------

/**
 * Scan tokens after a cmdlet name for a small, explicit set of known
 * parameters, gathering positional (non-flag) arguments in order. An
 * unrecognized `-Flag` rejects (returns null): this module can only skip
 * options whose grammar it actually knows.
 */
function powershellParams(args, { pathFlags = new Set(), valueFlags = new Set(), boolFlags = new Set() } = {}) {
  const flagValues = new Map();
  const positionals = [];
  let index = 0;
  while (index < args.length) {
    const token = args[index];
    const lower = token.toLowerCase();
    if (token.startsWith("-")) {
      if (pathFlags.has(lower) || valueFlags.has(lower)) {
        const value = args[index + 1];
        if (value === undefined || value.startsWith("-")) return null;
        flagValues.set(lower, value);
        index += 2;
        continue;
      }
      if (boolFlags.has(lower)) { index += 1; continue; }
      return null; // unknown option
    }
    positionals.push(token);
    index += 1;
  }
  return { flagValues, positionals };
}

function psContentWrite(args) {
  const scan = powershellParams(args, {
    pathFlags: new Set(["-path", "-filepath"]),
    valueFlags: new Set(["-value", "-encoding"]),
    boolFlags: new Set(["-force", "-nonewline", "-append"]),
  });
  if (!scan) return null;
  const target = scan.flagValues.get("-path") || scan.flagValues.get("-filepath") || scan.positionals[0];
  return target ? [{ target, kind: "edited" }] : null;
}

function psNewItem(args) {
  const scan = powershellParams(args, {
    pathFlags: new Set(["-path", "-name"]),
    valueFlags: new Set(["-itemtype", "-value"]),
    boolFlags: new Set(["-force"]),
  });
  if (!scan) return null;
  const target = scan.flagValues.get("-path") || scan.flagValues.get("-name") || scan.positionals[0];
  if (!target) return null;
  const itemType = scan.flagValues.get("-itemtype");
  if (itemType === undefined) return null; // ambiguous without an explicit type: fail closed
  if (itemType.toLowerCase() !== "file") return []; // e.g. a directory: recognized, not a file
  return [{ target, kind: "created" }];
}

function psRemoveItem(args) {
  const scan = powershellParams(args, {
    pathFlags: new Set(["-path", "-literalpath"]),
    boolFlags: new Set(["-force", "-recurse", "-confirm"]),
  });
  if (!scan) return null;
  const targets = [
    ...(scan.flagValues.get("-path") ? [scan.flagValues.get("-path")] : []),
    ...(scan.flagValues.get("-literalpath") ? [scan.flagValues.get("-literalpath")] : []),
    ...scan.positionals,
  ];
  return targets.length ? targets.map((target) => ({ target, kind: "deleted" })) : null;
}

function psCopyItem(args) {
  const scan = powershellParams(args, {
    pathFlags: new Set(["-path", "-literalpath", "-destination"]),
    boolFlags: new Set(["-force", "-recurse"]),
  });
  if (!scan) return null;
  const source = scan.flagValues.get("-path") || scan.flagValues.get("-literalpath") || scan.positionals[0];
  const destination = scan.flagValues.get("-destination")
    || (scan.flagValues.get("-path") || scan.flagValues.get("-literalpath") ? scan.positionals[0] : scan.positionals[1]);
  return source && destination ? [{ target: destination, kind: "edited" }] : null;
}

function psMoveItem(args) {
  const scan = powershellParams(args, {
    pathFlags: new Set(["-path", "-literalpath", "-destination"]),
    boolFlags: new Set(["-force"]),
  });
  if (!scan) return null;
  const source = scan.flagValues.get("-path") || scan.flagValues.get("-literalpath") || scan.positionals[0];
  const destination = scan.flagValues.get("-destination")
    || (scan.flagValues.get("-path") || scan.flagValues.get("-literalpath") ? scan.positionals[0] : scan.positionals[1]);
  return source && destination ? [{ target: destination, kind: "moved", previousTarget: source }] : null;
}

// Rename-Item's -NewName is a bare filename; the file stays in its source
// directory, so the resulting target is the source's directory joined with
// the new name.
function siblingPath(source, newName) {
  if (/[\\/]/u.test(newName)) return null; // -NewName must not itself be a path
  const lastSlash = Math.max(source.lastIndexOf("/"), source.lastIndexOf("\\"));
  return lastSlash === -1 ? newName : source.slice(0, lastSlash + 1) + newName;
}

function psRenameItem(args) {
  const scan = powershellParams(args, {
    pathFlags: new Set(["-path", "-literalpath"]),
    valueFlags: new Set(["-newname"]),
    boolFlags: new Set(["-force"]),
  });
  if (!scan) return null;
  const source = scan.flagValues.get("-path") || scan.flagValues.get("-literalpath") || scan.positionals[0];
  const newName = scan.flagValues.get("-newname")
    || (scan.flagValues.get("-path") || scan.flagValues.get("-literalpath") ? scan.positionals[0] : scan.positionals[1]);
  if (!source || !newName) return null;
  const target = siblingPath(source, newName);
  return target ? [{ target, kind: "moved", previousTarget: source }] : null;
}

function powershellCommand(words_) {
  const [head, ...rest] = words_;
  const name = head.toLowerCase();
  if (["set-content", "add-content", "out-file"].includes(name)) return psContentWrite(rest);
  if (name === "new-item") return psNewItem(rest);
  if (name === "remove-item") return psRemoveItem(rest);
  if (name === "copy-item") return psCopyItem(rest);
  if (name === "move-item") return psMoveItem(rest);
  if (name === "rename-item") return psRenameItem(rest);
  return null;
}

// ---------------------------------------------------------------------------
// Shared chain / pipe / redirect structure
// ---------------------------------------------------------------------------

function redirectCandidates(tokens) {
  const opTokens = tokens.filter((token) => token.type === "op");
  if (opTokens.length !== 1) return null; // ambiguous with more than one redirect
  const opIndex = tokens.findIndex((token) => token.type === "op");
  const before = words(tokens.slice(0, opIndex));
  const after = tokens.slice(opIndex + 1);
  if (!before.length) return null; // need a command
  if (after.length !== 1 || after[0].type !== "word") return null;
  return [{ target: after[0].value, kind: "edited" }];
}

function stageCandidates(tokens, shell) {
  if (tokens.some((token) => token.type === "op")) return redirectCandidates(tokens);
  const stageWords = words(tokens);
  if (!stageWords.length) return null;
  return shell === "posix" ? posixCommand(stageWords) : powershellCommand(stageWords);
}

function pipedCandidates(stages, shell) {
  if (shell !== "posix") return null; // piping into a recognized writer is POSIX-only (tee)
  const last = stages.at(-1);
  if (last.some((token) => token.type === "op")) return null;
  const lastWords = words(last);
  if (lastWords[0] !== "tee") return null;
  const teeResult = posixTee(lastWords);
  if (teeResult === null) return null;
  for (const stage of stages.slice(0, -1)) {
    if (stage.some((token) => token.type === "op")) return null;
    if (!posixReadOnly(words(stage))) return null;
  }
  return teeResult;
}

function commandStages(command) {
  const tokens = tokenize(command);
  if (!tokens) return null;
  const chainSegments = splitOnAny(tokens, [";", "&&"]);
  const stagesBySegment = [];
  for (const segment of chainSegments) {
    const pipeStages = splitOn(segment, "|");
    if (!pipeStages.length) continue;
    stagesBySegment.push(pipeStages);
  }
  return stagesBySegment;
}

/**
 * Candidate {target, kind, previousTarget?} file changes for one whole
 * shell command as an agent issued it. Recognizes chained (`&&`, `;`) and
 * piped (`|`, POSIX `tee` only) sequences of the write shapes documented at
 * the top of this module; rejects (returns []) anything it cannot fully
 * account for, including a `cd` anywhere in the command. At most 64 entries.
 */
export function shellFileChangeCandidates(command, { shell = "posix" } = {}) {
  if (typeof command !== "string" || !command.trim()) return [];
  if (shell !== "posix" && shell !== "powershell") return [];
  const stagesBySegment = commandStages(command);
  if (!stagesBySegment) return [];

  for (const pipeStages of stagesBySegment) {
    for (const stage of pipeStages) {
      const first = stage.find((token) => token.type === "word");
      if (first && first.value.toLowerCase() === "cd") return [];
    }
  }

  const candidates = [];
  for (const pipeStages of stagesBySegment) {
    const result = pipeStages.length > 1 ? pipedCandidates(pipeStages, shell) : stageCandidates(pipeStages[0], shell);
    if (result === null) return [];
    candidates.push(...result);
    if (candidates.length >= MAX_CANDIDATES) break;
  }
  return candidates.slice(0, MAX_CANDIDATES);
}
