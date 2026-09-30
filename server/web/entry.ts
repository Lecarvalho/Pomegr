/**
 * Server entry for the dashboard build. `vite.config.ts` compiles it to
 * `dist/server/index.js`, which `server/web/server.mjs` serves on Node through
 * vinext's production server.
 */
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> | Response };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

const entry = {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handler.fetch(request, env, ctx);
  },
};

export default entry;
