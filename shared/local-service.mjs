const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);

export class LocalServiceError extends Error {
  constructor(code) {
    super(code);
    this.name = "LocalServiceError";
    this.code = code;
    this.stack = `${this.name}: ${code}`;
  }
}

export function requireLoopbackHost(host, errorCode) {
  if (typeof host !== "string" || !LOOPBACK_HOSTS.has(host)) {
    throw new LocalServiceError(errorCode);
  }
  return host;
}

export function requirePort(port, errorCode) {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new LocalServiceError(errorCode);
  }
  return port;
}

export function safeServiceError(error, fallbackCode) {
  if (error instanceof LocalServiceError) return error;
  return new LocalServiceError(fallbackCode);
}

export async function listen(server, { host, port, startupErrorCode }) {
  await new Promise((resolve, reject) => {
    const onError = () => {
      server.removeListener("error", onError);
      server.removeListener("listening", onListening);
      reject(new LocalServiceError(startupErrorCode));
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    try {
      server.listen(port, host);
    } catch {
      onError();
    }
  });
}

export function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      server.close(() => resolve());
      server.closeIdleConnections?.();
    } catch {
      resolve();
    }
  });
}

export function createLocalServiceHandle(server, {
  host,
  normalExitCode,
  unexpectedExitCode,
  onClose,
}) {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new LocalServiceError(unexpectedExitCode);
  }

  let closeRequested = false;
  let closePromise;
  let resolveExit;
  const exit = new Promise((resolve) => {
    resolveExit = resolve;
  });

  server.once("close", () => {
    try {
      onClose?.();
    } finally {
      resolveExit(Object.freeze({
        code: closeRequested ? normalExitCode : unexpectedExitCode,
      }));
    }
  });

  function close() {
    if (closePromise) return closePromise;
    closeRequested = true;
    closePromise = closeServer(server);
    return closePromise;
  }

  const originHost = host.includes(":") ? `[${host}]` : host;
  return Object.freeze({
    server,
    host,
    port: address.port,
    origin: `http://${originHost}:${address.port}`,
    address: Object.freeze({ host, port: address.port }),
    exit,
    close,
  });
}
