import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@pomegr/renderer-trace": path.resolve("app/renderer-trace.ts"),
      "@pomegr/renderer-trace-response": path.resolve("app/renderer-trace-response.dev.ts"),
      "#pomegr/renderer-trace-response": path.resolve("app/renderer-trace-response.dev.ts"),
    },
  },
  test: {
    environment: "jsdom",
    include: ["tests/ui/**/*.test.{ts,tsx}"],
    setupFiles: ["./tests/ui/setup.ts"],
  },
});
