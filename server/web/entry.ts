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
