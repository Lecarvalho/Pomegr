const QUIET_CONSOLE_METHODS = Object.freeze(["debug", "error", "info", "log", "warn"]);

export function installQuietConsole(target = globalThis.console) {
  const discard = () => {};
  for (const method of QUIET_CONSOLE_METHODS) {
    Object.defineProperty(target, method, {
      configurable: false,
      enumerable: true,
      get() { return discard; },
      set() { /* Runtime warning filters may assign safely without enabling output. */ },
    });
  }
  return target;
}
