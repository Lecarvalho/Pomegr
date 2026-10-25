// A branch name Pomegr may pass to GitHub: a conservative subset of Git's ref rules (git check-ref-format).
// It allows no option-like start, no control or special characters, no empty or dotted path part, and no `.lock` part.

/** @param {unknown} value @returns {value is string} */
export function isBranchName(value) {
  return typeof value === "string" && value.length >= 1 && value.length <= 200 && /^[A-Za-z0-9._+/-]+$/u.test(value)
    && !/^[-/]|[./]$|\.\.|\/\//u.test(value)
    && value.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock"));
}
