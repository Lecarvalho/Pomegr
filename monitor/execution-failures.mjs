const FAILURE_CAUSES = new Set([
  "command_not_found",
  "invalid_path",
  "network_error",
  "not_found",
  "non_zero_exit",
  "permission_denied",
  "provider_error",
  "syntax_error",
  "tests_failed",
  "timed_out",
]);

const MAX_EVIDENCE_CHARACTERS = 32_000;

export function safeExecutionFailureCause(value) {
  return typeof value === "string" && FAILURE_CAUSES.has(value) ? value : null;
}

function boundedEvidence(values) {
  let evidence = "";
  const append = (value) => {
    if (evidence.length >= MAX_EVIDENCE_CHARACTERS || value === null || value === undefined) return;
    if (typeof value === "string") {
      evidence += `${value.slice(0, MAX_EVIDENCE_CHARACTERS - evidence.length)}\n`;
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) append(item);
      return;
    }
    if (typeof value === "object") {
      append(value.text);
      append(value.content);
      append(value.message);
    }
  };
  append(values);
  return evidence;
}

export function classifyExecutionFailure(values, { failed = true, exitCode = null } = {}) {
  if (!failed) return null;
  const evidence = boundedEvidence(values);

  if (/permission denied|access (?:is )?denied|operation not permitted|unauthorized|forbidden|requires? (?:escalated )?permissions?|outside (?:the )?(?:workspace|sandbox)|sandbox[^\r\n]{0,80}(?:denied|blocked|restriction)/i.test(evidence)) return "permission_denied";
  if (/timed? out|timeout(?: exceeded| expired)?|deadline exceeded/i.test(evidence)) return "timed_out";
  if (/not recognized as (?:the name of )?(?:a cmdlet|an internal|an external)|command not found|executable file not found|unknown command/i.test(evidence)) return "command_not_found";
  if (/filename, directory name, or volume label syntax is incorrect|invalid (?:file )?path|path syntax/i.test(evidence)) return "invalid_path";
  if (/cannot find (?:the )?(?:path|file)|no such file or directory|file not found|path not found|does not exist/i.test(evidence)) return "not_found";
  if (/syntax error|syntaxerror|parsererror|parse error|unexpected token/i.test(evidence)) return "syntax_error";
  if (/assertionerror|test(?:s| suite)? failed|failed tests?|\bFAIL\b[^\r\n]{0,80}(?:test|spec)/i.test(evidence)) return "tests_failed";
  if (/connection (?:refused|reset|failed)|could not resolve|failed to resolve|network (?:error|failure)|dns error|econn(?:refused|reset)|host unreachable/i.test(evidence)) return "network_error";
  if (Number.isInteger(exitCode) && exitCode !== 0) return "non_zero_exit";
  return "provider_error";
}
