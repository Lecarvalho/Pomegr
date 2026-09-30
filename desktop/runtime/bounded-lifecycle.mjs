export function withDeadline(promise, timeoutMs, errorCode, onLateResolve) {
  let settled = false;
  let timer;
  return new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      settled = true;
      reject(new Error(errorCode));
    }, timeoutMs);
    Promise.resolve(promise).then((value) => {
      if (settled) {
        try { onLateResolve?.(value); } catch { /* Late cleanup is best-effort. */ }
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }, () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(errorCode));
    });
  });
}
